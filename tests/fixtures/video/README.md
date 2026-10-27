# Video fixtures

Small clips for the fake renderer and the QA tests. Each stays under 200 KB. Regenerate with
`npx tsx scripts/make-fixtures.mts` (needs ffmpeg; see that script for the exact commands).

| File | What it is | Expected QA result (short format) |
| --- | --- | --- |
| good.mp4 | 1080x1920, 20 s, tone, still colour (first and last frame equal) | passes |
| short.mp4 | 1080x1920, 3 s, tone | fails `duration` |
| wrong-size.mp4 | 640x360, 20 s, tone | fails `size` |
| no-audio.mp4 | 1080x1920, 20 s, no audio track | fails `audio_present` |
| loop-mismatch.mp4 | 1080x1920, 20 s, brightness ramps black to white | warns `loop_seam` |
| corrupt.mp4 | first 2 KB of a real clip | cannot be probed |
