# Chatterbox voice presets

These presets are the output of the [Chatterbox speech encoder][encoder] at revision
`452d3f434aa592098f1eedac9099f33642ab2da5` run on 24 kHz mono reference audio. The reference clips are published
under CC0 for text-to-speech. The preset files contain conditioning tensors.

- **Kerstin** uses the verified recording `de_rhasspy-0007.flac` from the [Kerstin Voice Dataset][kerstin].
- **Thorsten** uses utterance ID `57` from the [Thorsten-Voice neutral mini dataset][thorsten] at revision
  `afacb9d80927c36307dc16991c99b927ffa0a702`.

Each file contains base64-encoded little-endian float32 values. The first three values give the number of
conditioning rows, audio tokens, and speaker feature rows. They are followed by the four flattened arrays
`audio_features`, `audio_tokens`, `speaker_embeddings`, and `speaker_features` in that order.

[encoder]: https://huggingface.co/onnx-community/chatterbox-multilingual-ONNX/tree/main/onnx
[kerstin]: https://github.com/rhasspy/dataset-voice-kerstin/blob/f73127135cf80d6ef52aef6af58c49774f4fd625/README.md
[thorsten]: https://huggingface.co/datasets/Thorsten-Voice/TV-24kHz-2025.12-Neutral-FT-Mini
