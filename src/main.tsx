import { Devvit } from '@devvit/public-api';
import {checkPostRestrictionSubmitEvent, settingsForPostSizeRestricter} from "./postSizeRestricter.js";

Devvit.configure({
  redditAPI: true, // <-- this allows you to interact with Reddit's data api
  redis: true,
});

Devvit.addSettings([
  settingsForPostSizeRestricter
]);

Devvit.addTrigger({
  event: "CommentSubmit",
  onEvent: checkPostRestrictionSubmitEvent,
});

export default Devvit;