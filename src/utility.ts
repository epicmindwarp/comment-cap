import {TriggerContext} from "@devvit/public-api";
import {addWeeks} from "date-fns";

export function replaceAll (input: string, pattern: string, replacement: string): string {
    return input.split(pattern).join(replacement);
}

export async function getSubredditName (context: TriggerContext): Promise<string> {
    const subredditName = await context.redis.get("subredditname");
    if (subredditName) {
        return subredditName;
    }

    const subreddit = await context.reddit.getCurrentSubreddit();
    await context.redis.set("subredditname", subreddit.name, {expiration: addWeeks(new Date(), 1)});
    return subreddit.name;
}