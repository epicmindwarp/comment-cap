import {CommentSubmit} from "@devvit/protos";
import {Flair, SettingsFormField, TriggerContext} from "@devvit/public-api";
import {replaceAll, getSubredditName} from "./utility.js";
import {addDays, formatRelative} from "date-fns";

// Taken shamelessly from https://github.com/fsvreddit/ukpf-helper/blob/main/src/postSizeRestricter.ts

enum PostRestricterSettingName {
    EnableFeature = "enablePostSizeRestricter",
    Threshold = "postSizeThreshold",
    FlairText = "postSizeFlairText",
    FlairTemplateId = "postSizeFlairTemplateId",
    CommentToAdd = "postSizeCommentToAdd",
    LockPost = "postSizelockPost",
    NotifyInModMail = "postSizenotifyInModMail",
    ModMailSubject = "postSizemodmailBody",
    ModMailBody = "postSizeModMailBody",
    OverwriteExistingFlair = "overwriteExistingFlair",
    OverwriteFlairTextToIgnore = "overwriteFlairTextToIgnore",
    EnhancedLogging = "enhancedLogging"
}

const LOWEST_SUPPORTED_THRESHOLD = 1;

export const settingsForPostSizeRestricter: SettingsFormField = {
    type: "group",
    label: "Post size restricter",
    helpText: "Update a post once a comment threshold is reached",
    fields: [
        {
            name: PostRestricterSettingName.EnableFeature,
            type: "boolean",
            label: "Enable post size restricter functionality",
            defaultValue: true,
        },
        {
            name: PostRestricterSettingName.Threshold,
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
            name: PostRestricterSettingName.OverwriteExistingFlair,
            type: "boolean",
            label: "Overwrite existing flair",
            defaultValue: false,
        },
        {
            name: PostRestricterSettingName.OverwriteFlairTextToIgnore,
            type: "string",
            label: "If overwrite enabled, flair text to ignore (comma seperated).",
        },
        {
            name: PostRestricterSettingName.CommentToAdd,
            type: "paragraph",
            label: "Comment to sticky on post when restricting",
            helpText: "Leave blank to omit a comment",
        },
        {
            name: PostRestricterSettingName.LockPost,
            type: "boolean",
            label: "Lock post on restriction",
            defaultValue: false,
        },
        {
            name: PostRestricterSettingName.NotifyInModMail,
            type: "boolean",
            label: "Send a Modmail Notifcation",
            defaultValue: false,
        },
        {
            name: PostRestricterSettingName.ModMailSubject,
            type: "string",
            label: "Message to include in modmail",
            defaultValue: "Post Notification - {number_of_comments} comments"
        },
        {
            name: PostRestricterSettingName.ModMailBody,
            type: "paragraph",
            label: "Message to include in modmail",
            defaultValue: "FYA: {submission_permalink}\n\nPosted: {submission_age}\n\n[Trigger Comment.]({comment_permalink})"
        },
        {
            name: PostRestricterSettingName.EnhancedLogging,
            type: "boolean",
            label: "Enhanced Logs",
            defaultValue: false,
        },
    ],
};

export async function checkPostRestrictionSubmitEvent (event: CommentSubmit, context: TriggerContext) {

    const comment = await context.reddit.getCommentById(event.comment.id);
    const post = await context.reddit.getPostById(event.post.id);

    // Ignore any comments by AutoModerator, to not clog up the logs
    if (comment.authorName === 'AutoModerator'){
        return
    }

    const settings = await context.settings.getAll();
    const functionEnabled = settings[PostRestricterSettingName.EnableFeature] as boolean;
    if (!functionEnabled) {
        console.log("Function not enabled.");
        return;
    }

    const enhancedLogging = settings[modQScannerSettingName.EnhancedLogging] as boolean;

    const redisKey = `alreadyflaired~${event.post.id}`;
    const alreadyFlaired = await context.redis.get(redisKey);
    if (alreadyFlaired) {

        if (enhancedLogging) {
            console.log("Already flaired");
        }
        return;
    }

    console.log('\nTriggered by: ' +  comment.permalink)

    if (!event.post || !event.subreddit) {
        // Post not defined (unlikely), or flair already assigned.
        console.log("Post not defined (unlikely), or flair already assigned.");
        return;
    }

    const postSizeThreshold = settings[PostRestricterSettingName.Threshold] as number;
    if (!postSizeThreshold) {
        // Function misconfigured, or not enough comments yet.
        console.log("Function misconfigured! Check settings! postSizeThreshold: " + postSizeThreshold.toString());
        return;
    }

    const num_comments = event.post.numComments
    if (num_comments < postSizeThreshold) {
        // Function misconfigured, or not enough comments yet.
        console.log("Not enough comments (" + num_comments + ").");
        return;
    }

    let postSizeFlairText = settings[PostRestricterSettingName.FlairText] as string | undefined;
    if (postSizeFlairText === "") {
        console.log("FlairText is empty");
        postSizeFlairText = undefined;
    }

    let postSizeFlairTemplateId = settings[PostRestricterSettingName.FlairTemplateId] as string | undefined;
    if (postSizeFlairTemplateId === "") {
        postSizeFlairTemplateId = undefined;
        console.log("FlairTemplateId is undefined");
    }

    const overwriteExistingFlair = settings[PostRestricterSettingName.OverwriteExistingFlair] as boolean;

    // If flair should be overwritten
    if (overwriteExistingFlair) {

        // Check if it's a flair we should ignore
        const OverwriteFlairTextToIgnore = settings[PostRestricterSettingName.OverwriteFlairTextToIgnore] as string ?? "";
        let overwriteFlairTextToIgnore = OverwriteFlairTextToIgnore.split(",").map(flair => flair.trim().toLowerCase());

        // Add the main flair too, automatically
        let overwriteFlairTextToIgnore.push(postSizeFlairText)

        // If it's set to flair we should ignore, then do nothing
        if (overwriteFlairTextToIgnore.includes(event.post.linkFlair.text.toLowerCase())) {
                console.log("Flair and flair text already set to " + event.post.linkFlair.text.toString() + " (Ignore flair overwrite)");
                return;
            }
    } else {
        // If we can't overwrite any existing flair, ensure a flair isn't already set
        if (event.post.linkFlair && event.post.linkFlair.text) {
                console.log("Flair and flair text already set to " + event.post.linkFlair.text.toString());
                return;
            }
    }

    if (postSizeFlairText || postSizeFlairTemplateId) {
        await context.reddit.setPostFlair({
            postId: event.post.id,
            subredditName: event.subreddit.name,
            text: postSizeFlairText,
            flairTemplateId: postSizeFlairTemplateId,
        });

        console.log("Post Restricter: Flair set.\n");
    }

    // Setting: Add a comment after actioning
    const postSizeCommentToAdd = settings[PostRestricterSettingName.CommentToAdd] as string;

    if (postSizeCommentToAdd) {
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

            console.log("Comment added");
        } else {
            console.log("Not adding comment due to existing sticky.");
        }
    }

    // Setting: Lock post
    const postSizelockPost = settings[PostRestricterSettingName.LockPost] as string;   
    if (postSizelockPost) {
        await post.lock();
    };

    // Setting: Send modmail
    const notifyInModMail = settings[PostRestricterSettingName.NotifyInModMail] as string;
    if (notifyInModMail) {
        
        const subredditName = await getSubredditName(context);
        
        let modMailSubject = replaceAll(settings[PostRestricterSettingName.ModMailSubject] as string, '{number_of_comments}', post.numberOfComments);

        let modMailBody = replaceAll(settings[PostRestricterSettingName.ModMailBody] as string, '{submission_permalink}', post.permalink);
        modMailBody = replaceAll(modMailBody, '{comment_permalink}', comment.permalink);
        modMailBody = replaceAll(modMailBody, '{submission_age}', formatRelative(post.createdAt, new Date()));

        await context.reddit.sendPrivateMessage({
            subject: modMailSubject,
            text: modMailBody,
            to: '/r/'+ subredditName
        });
 
        console.log('modmailSent to ' + subredditName + ': ' + modMailSubject.toString())

        await context.redis.set(redisKey, "true", {expiration: addDays(new Date(), 7)});
    };
}