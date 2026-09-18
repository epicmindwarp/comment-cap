import { Hono } from 'hono';
import { context, reddit, redis, settings } from '@devvit/web/server';
import {
  T1,
  T3,
  type OnCommentSubmitRequest,
  type SettingsValidationRequest,
  type SettingsValidationResponse,
  type TriggerResponse,
} from '@devvit/web/shared';
import { addDays, formatRelative } from 'date-fns';

const LOWEST_SUPPORTED_THRESHOLD = 1;
const ALREADY_ACTIONED_TTL_DAYS = 7;

type CcSettingsValues = {
  enableCommentCap: boolean;
  commentCapThreshold: number;
  ccFlairTemplateId?: string;
  ccFlairText?: string;
  overwriteExistingPostFlair: boolean;
  overwriteFlairTextToIgnore?: string;
  ccCommentToAdd?: string;
  overwriteExistingStickyComment: boolean;
  ccLockPost: boolean;
  ccNotifyInModMail: boolean;
  ccModMailSubject: string;
  ccModMailBody: string;
  enhancedLogging: boolean;
};

export const commentCapRoutes = new Hono();

commentCapRoutes.post('/triggers/comment-submit', async (c) => {
  const input = await c.req.json<OnCommentSubmitRequest>();
  await handleCommentSubmit(input);
  return c.json<TriggerResponse>({ status: 'ok' });
});

commentCapRoutes.post('/settings/validate-threshold', async (c) => {
  const { value } = await c.req.json<SettingsValidationRequest<number>>();
  if (!value || value < LOWEST_SUPPORTED_THRESHOLD) {
    return c.json<SettingsValidationResponse>({
      success: false,
      error: `You must specify a number of comments greater than or equal to ${LOWEST_SUPPORTED_THRESHOLD}`,
    });
  }
  return c.json<SettingsValidationResponse>({ success: true });
});

function enhancedLog(enabled: boolean, message: string): void {
  if (enabled) console.log('\t# ', message);
}

async function handleCommentSubmit(event: OnCommentSubmitRequest): Promise<void> {
  if (!event.comment || !event.post || !event.author || !event.subreddit) {
    console.log('# ABORT - Event is not in the required state\n');
    return;
  }

  const commentId = T1(event.comment.id);
  const postId = T3(event.post.id);

  const comment = await reddit.getCommentById(commentId);
  const post = await reddit.getPostById(postId);
  const subredditName = context.subredditName;

  const settingsValues = await settings.getAll<CcSettingsValues>();
  if (!settingsValues.enableCommentCap) {
    enhancedLog(settingsValues.enhancedLogging, 'Function not enabled.\n');
    return;
  }

  // Ignore any comments by bots, to not clog up the logs
  const appUser = await reddit.getAppUser();
  if (comment.authorName === 'AutoModerator' || comment.authorId === appUser?.id) {
    return;
  }

  console.log(
    `Trigger: /r/${subredditName}/comments/${post.id.replace('t3_', '')}/_/${comment.id.replace('t1_', '')}`
  );

  // For anything already flaired, check redis first
  const redisKey = `alreadyflaired~${event.post.id}`;
  const alreadyFlaired = await redis.get(redisKey);
  if (alreadyFlaired) {
    enhancedLog(settingsValues.enhancedLogging, 'Already flaired (checked via redis)\n');
    return;
  }

  const commentCapThreshold = settingsValues.commentCapThreshold;
  if (!commentCapThreshold) {
    console.log(`ABORT: commentCapThreshold may not be defined ${commentCapThreshold}\n`);
    return;
  }

  const numberOfCommentsInPost = event.post.numComments;
  if (numberOfCommentsInPost < commentCapThreshold) {
    console.log(`# Skipped - Not enough comments (${numberOfCommentsInPost}/${commentCapThreshold})\n`);
    return;
  } else {
    console.log(`\nProcessing: ${post.permalink} - (${numberOfCommentsInPost}/${commentCapThreshold} comments)`);
  }

  // Flair text to set the post to
  let ccFlairText = settingsValues.ccFlairText;
  if (!ccFlairText) {
    enhancedLog(settingsValues.enhancedLogging, 'FlairText is empty');
    ccFlairText = undefined;
  }

  let ccFlairTemplateId = settingsValues.ccFlairTemplateId;
  if (ccFlairTemplateId === '') {
    ccFlairTemplateId = undefined;
    enhancedLog(settingsValues.enhancedLogging, 'FlairTemplateId is undefined');
  }

  const currentPostFlair = event.post.linkFlair;

  // Check if it's a flair we should ignore
  const overwriteFlairTextToIgnoreRaw = settingsValues.overwriteFlairTextToIgnore ?? '';
  const overwriteFlairTextToIgnore = overwriteFlairTextToIgnoreRaw
    .split(',')
    .map((flair) => flair.trim().toLowerCase());

  // If the only entry in the list is not the blanks
  if (!(overwriteFlairTextToIgnore.length === 1 && ''.includes(overwriteFlairTextToIgnoreRaw))) {
    enhancedLog(settingsValues.enhancedLogging, `overwriteFlairText**ToIgnore**: "${overwriteFlairTextToIgnore}"`);

    // Assuming there already is a flair in place
    if (currentPostFlair) {
      // If it's set to a flair we should ignore, then do nothing
      if (overwriteFlairTextToIgnore.includes(currentPostFlair.text.toLowerCase())) {
        console.log(`Abort - Ignore flair: "${currentPostFlair.text}" (Ignore flair overwrite)\n`);
        return;
      }
    }
  }

  // If we cannot overwrite an existing flair, but we need to as flairs given
  const overwriteExistingPostFlair = settingsValues.overwriteExistingPostFlair;
  if (!overwriteExistingPostFlair && (ccFlairText || ccFlairTemplateId)) {
    // If we can't overwrite an existing flair, ensure a flair isn't already set
    if (currentPostFlair && currentPostFlair.text) {
      console.log(`Skipping: Post flair already set to ${currentPostFlair.text}\n`);
      return;
    }
  }

  // If a text or template was provided
  if (ccFlairText || ccFlairTemplateId) {
    // Set the flairs
    await reddit.setPostFlair({
      postId,
      subredditName: event.subreddit.name,
      text: ccFlairText,
      flairTemplateId: ccFlairTemplateId,
    });

    console.log('Comment Cap: Flair set.\n');
  }

  // Setting: Add a comment after actioning
  const ccCommentToAdd = settingsValues.ccCommentToAdd;
  if (ccCommentToAdd) {
    const overwriteExistingStickyComment = settingsValues.overwriteExistingStickyComment;
    const commentsOnPost = await post.comments.all();
    const existingSticky = commentsOnPost.find((c) => c.isStickied());

    if (!existingSticky || overwriteExistingStickyComment) {
      const newComment = await reddit.submitComment({
        id: postId,
        text: ccCommentToAdd,
      });

      await Promise.all([newComment.distinguish(true), newComment.lock()]);

      console.log('Comment added\n');
    } else {
      console.log('Not adding comment due to existing sticky\n');
    }
  }

  // Setting: Lock post
  if (settingsValues.ccLockPost) {
    console.log('Post locked.');
    await post.lock();
  }

  // Setting: Send modmail
  if (settingsValues.ccNotifyInModMail) {
    const modMailSubject = settingsValues.ccModMailSubject.replaceAll(
      '{number_of_comments}',
      numberOfCommentsInPost.toString()
    );
    let modMailBody = settingsValues.ccModMailBody.replaceAll('{submission_permalink}', post.permalink);

    modMailBody = modMailBody.replaceAll('{comment_permalink}', comment.permalink);
    modMailBody = modMailBody.replaceAll('{submission_age}', formatRelative(post.createdAt, new Date()));

    await reddit.sendPrivateMessage({
      subject: modMailSubject,
      text: modMailBody,
      to: `/r/${subredditName}`,
    });

    console.log(`modmailSent to ${subredditName} : ${modMailSubject}\n`);
  }

  await redis.set(redisKey, 'true', { expiration: addDays(new Date(), ALREADY_ACTIONED_TTL_DAYS) });
  console.log('Finished.\n');
}
