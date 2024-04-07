import {CommentSubmit} from "@devvit/protos";
import {SettingsFormField, TriggerContext} from "@devvit/public-api";
import {addDays} from "date-fns";

// Taken shamelessly from https://github.com/fsvreddit/ukpf-helper/blob/main/src/postSizeRestricter.ts

enum PostRestricterSettingName {
    EnableFeature = "enablePostSizeRestricter",
    Threshold = "postSizeThreshold",
    FlairText = "postSizeFlairText",
    FlairTemplateId = "postSizeFlairTemplateId",
    CommentToAdd = "postSizeCommentToAdd",
}

const LOWEST_SUPPORTED_THRESHOLD = 1;

export const settingsForPostSizeRestricter: SettingsFormField = {
    type: "group",
    label: "Post size restricter",
    helpText: "Changes a post flair once a comment threshold is reached",
    fields: [
        {
            name: PostRestricterSettingName.EnableFeature,
            type: "boolean",
            label: "Enable post size restricter functionality",
            defaultValue: false,
        },
        {
            name: PostRestricterSettingName.Threshold,
            type: "number",
            label: "Number of comments to trigger flair change at",
            defaultValue: 150,
            onValidate: ({value}) => {
                if (!value || value < LOWEST_SUPPORTED_THRESHOLD) {
                    return `You must specify a number of comments greater than or equal to ${LOWEST_SUPPORTED_THRESHOLD}`;
                }
            },
        },
        {
            name: PostRestricterSettingName.FlairText,
            type: "string",
            label: "Post flair to assign",
        },
        {
            name: PostRestricterSettingName.FlairTemplateId,
            type: "string",
            label: "Post flair template to apply",
        },
        {
            name: PostRestricterSettingName.CommentToAdd,
            type: "paragraph",
            label: "Comment to sticky on post when restricting",
            helpText: "Leave blank to omit a comment",
        },
    ],
};

export async function checkPostRestrictionSubmitEvent (event: CommentSubmit, context: TriggerContext) {
    if (!event.post || !event.subreddit) {
        // Post not defined (unlikely), or flair already assigned.
        return;
    }

    if (event.post.numComments < LOWEST_SUPPORTED_THRESHOLD) {
        return;
    }

    if (event.post.linkFlair && event.post.linkFlair.text) {
        return;
    }

    const settings = await context.settings.getAll();

    const postSizeThreshold = settings[PostRestricterSettingName.Threshold] as number;
    if (!postSizeThreshold || event.post.numComments < postSizeThreshold) {
        // Function misconfigured, or not enough comments yet.
        return;
    }

    const functionEnabled = settings[PostRestricterSettingName.EnableFeature] as boolean;
    if (!functionEnabled) {
        return;
    }

    const redisKey = `alreadyflaired~${event.post.id}`;
    const alreadyFlaired = await context.redis.get(redisKey);
    if (alreadyFlaired) {
        return;
    }

    let postSizeFlairText = settings[PostRestricterSettingName.FlairText] as string | undefined;
    if (postSizeFlairText === "") {
        postSizeFlairText = undefined;
    }

    let postSizeFlairTemplateId = settings[PostRestricterSettingName.FlairTemplateId] as string | undefined;
    if (postSizeFlairTemplateId === "") {
        postSizeFlairTemplateId = undefined;
    }

    if (postSizeFlairText || postSizeFlairTemplateId) {
        await context.reddit.setPostFlair({
            postId: event.post.id,
            subredditName: event.subreddit.name,
            text: postSizeFlairText,
            flairTemplateId: postSizeFlairTemplateId,
        });

        console.log("Post Restricter: Flair set.");
    }

    const postSizeCommentToAdd = settings[PostRestricterSettingName.CommentToAdd] as string;

    if (postSizeCommentToAdd) {
        const post = await context.reddit.getPostById(event.post.id);
        const commentsOnPost = await post.comments.all();
        const existingSticky = commentsOnPost.find(comment => comment.isStickied());

        if (!existingSticky) {
            const newComment = await context.reddit.submitComment({
                id: event.post.id,
                text: postSizeCommentToAdd,
            });

            await Promise.all([
                newComment.distinguish(true),
                newComment.lock(),
            ]);

            console.log("Post Restricter: Comment added");
        } else {
            console.log("Post Restricter: Not adding comment due to existing sticky.");
        }
    }

    await context.redis.set(redisKey, "true", {expiration: addDays(new Date(), 7)});
}