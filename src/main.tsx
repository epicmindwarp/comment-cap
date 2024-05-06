import { Devvit } from '@devvit/public-api';
import {checkCommentCapSubmitEvent, CcSettings} from "./commentCap.js";

Devvit.configure({
  redditAPI: true, // <-- this allows you to interact with Reddit's data api
  redis: true,
});

Devvit.addSettings([
  CcSettings
]);

Devvit.addTrigger({
  event: "CommentSubmit",
  onEvent: checkCommentCapSubmitEvent,
});

export default Devvit;