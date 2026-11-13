// PLACEHOLDER — voiceStatus is "pending" in beats.json. Estimated line windows only (no
// per-word times yet); Captions falls back to its own weighted-by-length word estimator.
// Will be overwritten by tools/gen_voice.py once ElevenLabs timings exist — do not hand-edit then.
import type { VoLine } from '../../lib/shorts';

export const VO: VoLine[] = [
  { text: "This ad didn't get deleted. It never left your laptop.", start: 0.4, end: 4.1 },
  { text: 'Load a page, and it quietly calls out to dozens of servers — for images, scripts, and ads.', start: 4.4, end: 10.33 },
  { text: "An extension checks every request's address against a filter list of known ad-server patterns.", start: 10.7, end: 15.89 },
  { text: 'The moment it matches, the browser cancels the request before it even opens a connection.', start: 16.2, end: 21.76 },
  { text: 'The server on the other end never responds — because it was never asked.', start: 22.06, end: 26.87 },
  { text: "That list isn't AI. It's plain text, maintained by a handful of volunteers.", start: 27.37, end: 32.18 },
  { text: 'Loaded into uBlock Origin, Adblock Plus, every major blocker.', start: 32.48, end: 35.81 },
  { text: 'No request. No response. No ad.', start: 36.31, end: 38.53 },
];
