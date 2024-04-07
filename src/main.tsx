import { Devvit } from '@devvit/public-api';
import {checkPostRestrictionSubmitEvent, settingsForPostSizeRestricter} from "./postSizeRestricter.js";

Devvit.addSettings([
  settingsForPostSizeRestricter
]);

Devvit.addTrigger({
  event: "CommentSubmit",
  onEvent: checkPostRestrictionSubmitEvent,
});

export default Devvit;