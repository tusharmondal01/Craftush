# Stunning Visuals — simplified narration sync

1. Create scenes from your script, write prompts, then generate the images as usual.
2. In the final step, choose the narration language and add the exact final audio (or HeyGen video). Sync starts automatically. Keep the tab open; the first run needs an internet connection to download the speech model.
3. Play the narration and watch the images change. Each card shows its line, image filename, link and exact start/end. Use Listen to hear the full line through its next image cut.
4. If a card is highlighted, listen and correct its start. Use playhead or type a time, then tick Start checked. Missing or uncertain timing is never replaced with proportional guesses.
5. Tick Preview checked and download the complete ZIP. Unzip into one folder and import timeline.xml into Premiere. Relink 001.jpg and narration.wav from that folder if prompted. Narration begins at sequence 0:00.

Use Retry sync if recognition fails. Use subtitle timings or fix sync accepts an SRT from the same audio. Manual starts remain in timeline settings. New audio invalidates old subtitle timings and reviews.

The complete download includes numbered JPGs, narration.wav, timeline.xml, timing.json, image-links.json, prompts.json, prompts.txt and transitions.json. The same stable scene ID joins the script line to its image file, optional provider URL and verified frame range. Generated source URLs may expire; the ZIP includes image bytes so Premiere uses local files.

Separate downloads contains image-only and XML-only options. A prompts.json import restores scenes and prompts, not image bytes. For a timing-only repair, use your existing matching numbered JPGs beside the downloaded timeline/audio package.

This source archive must be deployed to update the live website. It does not itself publish a deployment. Real narration recognition can still need corrections; review the preview before exporting.
