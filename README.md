# asr-cli

A command-line interface for ASR (Automatic Speech Recognition) tasks.

## Features

- Transcribe audio files
- Extensible subcommand architecture
- Python 3.9+

## Installation

```bash
pip install -e .
```

## Usage

```bash
# Show help
asr-cli --help

# Transcribe an audio file
asr-cli transcribe audio.wav --language zh --output result.txt
```

## Development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest
```
