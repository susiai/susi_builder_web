# Play music and internet radio

**Find this skill for** music app, radio player, playback, streaming audio, Musik, Radio-App, Internetradio, abspielen.

## Build an app that plays audio

When the user asks to build or change an app, implement the player in the selected project. Inspect its existing
files, then create or edit `./index.html` and any required styles or scripts with the available file tools.
Use the requested source. If the user wants a personal radio demo and has no station preference, use Groove Salad.
If the active agent cannot write files, tell the user to switch to Builder.

Use the browser's native HTML player for a direct MP3 stream or a local MP3 file. No JavaScript library is needed.
Use the direct stream URL as the audio source and leave autoplay off. For a local track, use its relative file path.
Keep the controls visible so the user can start, pause and change the volume.

```html
<audio controls preload="none" src="https://ice5.somafm.com/groovesalad-128-mp3"></audio>
```

Add a visible status near the player. When the audio element emits an `error`, tell the user the source could not be
played and offer the station page as a fallback when available. If you build custom controls, call `audio.play()` from
the user's Play click and handle a rejected promise. Use MP3 for a basic browser player. An M3U or PLS station list
contains stream addresses and is not the audio source.

After saving, tell the user to open **Preview**, turn on **Allow remote resources** for an external stream, and press
**Play** inside the app. Verify that playback starts or mark it as unverified. Inspecting the file or seeing the
controls only verifies that the player was built.

## Play music using an existing player

If the user asks to play music and has already shared a player tab in Browser, read its controls and request the Play
action through the normal approval flow. Otherwise, offer the station page and direct the user to its Play control.
Report playback as started only when the player confirms it.

## Groove Salad sources

- [Browser player and station information](https://somafm.com/groovesalad/)
- [Direct MP3 stream for personal listening](https://ice5.somafm.com/groovesalad-128-mp3)
- [M3U playlist for compatible media players](https://somafm.com/m3u/groovesalad.m3u)

These streams are for personal listening. For a public or distributed app, use an audio source the user has permission
to include. Check [SomaFM's published stream list](https://somafm.com/groovesalad/directstreamlinks.html) for alternate
formats or an updated address.
