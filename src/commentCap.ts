import {CommentSubmit} from "@devvit/protos";
import {SettingsFormField, TriggerContext} from "@devvit/public-api";
import {replaceAll, getSubredditName, ThingPrefix} from "./utility.js";
import {addDays, formatRelative} from "date-fns";

enum CcSettingName {
    EnableFeature = "enableCommentCap",
    Threshold = "commentCapThreshold",
    FlairText = "ccFlairText",
    FlairTemplateId = "ccFlairTemplateId",
    CommentToAdd = "ccCommentToAdd",
    LockPost = "ccLockPost",
    NotifyInModMail = "ccNotifyInModMail",
    ModMailSubject = "ccModMailSubject",
    ModMailBody = "ccModMailBody",
    OverwriteExistingPostFlair = "overwriteExistingPostFlair",
    OverwriteFlairTextToIgnore = "overwriteFlairTextToIgnore",
    EnhancedLogging = "enhancedLogging"
}


const LOWEST_SUPPORTED_THRESHOLD = 1;


export const CcSettings: SettingsFormField = {

    type: "group",
    label: "Comment Cap",
    helpText: "Lock a post once a comment threshold is reached, with option to set a flair, leave a comment, and send modmail.",
    fields: [
        {
            name: CcSettingName.EnableFeature,
            type: "boolean",
            label: "Enable Comment Cap",
            defaultValue: true,
        },
        {
            name: CcSettingName.Threshold,
            type: "number",
            label: "Number of comments to trigger actions at",
            defaultValue: 150,
            onValidate: ({value}) => {
                if (!value || value < LOWEST_SUPPORTED_THRESHOLD) {
                    return `You must specify a number of comments greater than or equal to ${LOWEST_SUPPORTED_THRESHOLD}`;
                }
            },
        },
        {
            name: CcSettingName.FlairTemplateId,
            type: "string",
            label: "Post flair template to apply",
        },
        {
            name: CcSettingName.FlairText,
            type: "string",
            label: "(Optional) Post flair text to apply if different to template ID text",
        },
        {
            name: CcSettingName.OverwriteExistingPostFlair,
            type: "boolean",
            label: "Overwrite existing flair",
            defaultValue: false,
        },
        {
            name: CcSettingName.OverwriteFlairTextToIgnore,
            type: "string",
            label: "If overwrite enabled, flair text to ignore (comma seperated).",
        },
        {
            name: CcSettingName.CommentToAdd,
            type: "paragraph",
            label: "Comment to sticky on post when triggered",
            helpText: "Leave blank to omit a comment",
        },
        {
            name: CcSettingName.LockPost,
            type: "boolean",
            label: "Lock post when triggered",
            defaultValue: false,
        },
        {
            name: CcSettingName.NotifyInModMail,
            type: "boolean",
            label: "Send a Modmail Notifcation",
            defaultValue: false,
        },
        {
            name: CcSettingName.ModMailSubject,
            type: "string",
            label: "Message to include in modmail",
            defaultValue: "Post Notification - {number_of_comments} comments"
        },
        {
            name: CcSettingName.ModMailBody,
            type: "paragraph",
            label: "Message to include in modmail",
            defaultValue: "FYA: {submission_permalink}\n\nPosted: {submission_age}\n\n[Trigger Comment.]({comment_permalink})"
        },
        {
            name: CcSettingName.EnhancedLogging,
            type: "boolean",
            label: "Enhanced Logging (for developers)",
            defaultValue: false,
        }
    ],
};


async function enhancedLog(context: TriggerContext, printMessage: string) {

    // Function only displays print statements when Enhanced Logging option is set to true

    const settings          = await context.settings.getAll();
    const enhancedLogging   = settings[CcSettingName.EnhancedLogging] as boolean;

    // If enhancedLogging is enabled, display this log
    if (enhancedLogging) {
        console.log('\t# ', printMessage);
    }
}


export async function checkCommentCapSubmitEvent(event: CommentSubmit, context: TriggerContext) {

    if (!event.comment || !event.post || !event.author || !event.subreddit) {
        console.log("# ABORT - Event is not in the required state\n");
        return;
    }

    const comment = await context.reddit.getCommentById(event.comment.id);
    const post = await context.reddit.getPostById(event.post.id);
    const subredditName = await getSubredditName(context);

    const settings = await context.settings.getAll();
    const functionEnabled = settings[CcSettingName.EnableFeature] as boolean;
    if (!functionEnabled) {
        await enhancedLog(context, "Function not enabled.\n")
        return;
    }

    // Ignore any comments by bots, to not clog up the logs
    if (comment.authorName === 'AutoModerator' || comment.authorId === context.appAccountId ){
        return
    }

    console.log(`Trigger: /r/${subredditName}/comments/${post.id.replace(ThingPrefix.Post, '')}/_/${comment.id.replace(ThingPrefix.Comment, '')}`)

    // For anything already flaired, check the redis db first
    const redisKey = `alreadyflaired~${event.post.id}`;
    const alreadyFlaired = await context.redis.get(redisKey);
    if (alreadyFlaired) {
            await enhancedLog(context, "Already flaired (checked via redis)\n");
            //await context.redis.del(redisKey);
            return;
    }

    const commentCapThreshold = settings[CcSettingName.Threshold] as number;
    if (!commentCapThreshold) {
        // Function misconfigured, or not enough comments yet.
        console.log(`ABORT: commentCapThreshold may not be defined ${commentCapThreshold}\n`);
        return;
    }

    const numberOfCommentsInPost = event.post.numComments
    if (numberOfCommentsInPost < commentCapThreshold) {
        console.log(`# Skipped - Not enough comments (${numberOfCommentsInPost}/${commentCapThreshold})\n`);
        return;
    }
    else {
        console.log(`\nProcessing: ${post.permalink} - (${numberOfCommentsInPost}/${commentCapThreshold} comments)`)
    }


    // Flair text to set the post to
    let ccFlairText = settings[CcSettingName.FlairText] as string | undefined;
    if (!ccFlairText) {
        await enhancedLog(context, "FlairText is empty");
        ccFlairText = undefined;
    }

    let ccFlairTemplateId = settings[CcSettingName.FlairTemplateId] as string | undefined;
    if (ccFlairTemplateId === "") {
        ccFlairTemplateId = undefined;
        await enhancedLog(context, "FlairTemplateId is undefined");
    }


    const currentPostFlair = event.post.linkFlair

    // Check if it's a flair we should ignore
    const OverwriteFlairTextToIgnore = settings[CcSettingName.OverwriteFlairTextToIgnore] as string ?? "";
    let overwriteFlairTextToIgnore = OverwriteFlairTextToIgnore.split(",").map(flair => flair.trim().toLowerCase());

    // If the only entry in the list is not the blanks
    if (!(overwriteFlairTextToIgnore.length == 1 && "".includes(OverwriteFlairTextToIgnore))) {

        await enhancedLog(context, `overwriteFlairText**ToIgnore**: "${overwriteFlairTextToIgnore}"`)

        // Assuming there already is a flair in place
        if (currentPostFlair) {
            // If it's set to flair we should ignore, then do nothing
            if (overwriteFlairTextToIgnore.includes(currentPostFlair.text.toLowerCase())) {
                    console.log(`Abort - Ignore flair: "${currentPostFlair.text}" (Ignore flair overwrite)\n`);
                    return;}
            }
        }


    // If we cannot overwrite an existing flair, but we need to as flairs given
    const overwriteExistingPostFlair = settings[CcSettingName.OverwriteExistingPostFlair] as boolean;
    if (!overwriteExistingPostFlair && (ccFlairText || ccFlairTemplateId)) {
        {
            // If we can't overwrite an existing flair, ensure a flair isn't already set
            if (currentPostFlair && currentPostFlair.text) {
                    console.log(`Skipping: Post flair already set to ${currentPostFlair.text}\n`);
                    return;
                }
        }
    }


    // If a text or template was provided
    if (ccFlairText || ccFlairTemplateId) {

        // Set the flairs
        await context.reddit.setPostFlair({
            postId: event.post.id,
            subredditName: event.subreddit.name,
            text: ccFlairText,
            flairTemplateId: ccFlairTemplateId,
        });

        console.log("Comment Cap: Flair set.\n");
    }

    // Setting: Add a comment after actioning
    const ccCommentToAdd = settings[CcSettingName.CommentToAdd] as string;
    if (ccCommentToAdd) {

        const commentsOnPost = await post.comments.all();
        const existingSticky = commentsOnPost.find(comment => comment.isStickied());

        if (!existingSticky) {
            const newComment = await context.reddit.submitComment({
                id: event.post.id,
                text: ccCommentToAdd,
            });

            await Promise.all([
                newComment.distinguish(true),
                newComment.lock(),
            ]);

            console.log("Comment added\n");
        } else {
            console.log("Not adding comment due to existing sticky\n");
        }
    }

    // Setting: Lock post
    const ccLockPost = settings[CcSettingName.LockPost] as string;   
    if (ccLockPost) {
        console.log('Post locked.')
        await post.lock();
    };

    // Setting: Send modmail
    const notifyInModMail = settings[CcSettingName.NotifyInModMail] as string;
    if (notifyInModMail) {

        let modMailSubject = replaceAll(settings[CcSettingName.ModMailSubject] as string, '{number_of_comments}', numberOfCommentsInPost.toString());
        let modMailBody = replaceAll(settings[CcSettingName.ModMailBody] as string, '{submission_permalink}', post.permalink);
        
        modMailBody = replaceAll(modMailBody, '{comment_permalink}', comment.permalink);
        modMailBody = replaceAll(modMailBody, '{submission_age}', formatRelative(post.createdAt, new Date()));

        await context.reddit.sendPrivateMessage({
            subject: modMailSubject,
            text: modMailBody,
            to: `/r/${subredditName}`
        });
    
        console.log(`modmailSent to ${subredditName} : ${modMailSubject}\n`)
        
    };

    await context.redis.set(redisKey, "true", {expiration: addDays(new Date(), 7)});
    console.log('Finished.\n')

}