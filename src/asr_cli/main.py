import argparse
import sys

from asr_cli import __version__


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="asr-cli",
        description="A command-line interface for ASR tasks.",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    transcribe = subparsers.add_parser("transcribe", help="Transcribe an audio file")
    transcribe.add_argument("audio", help="Path to the audio file")
    transcribe.add_argument(
        "--language",
        "-l",
        default="auto",
        help="Language code (default: auto)",
    )
    transcribe.add_argument(
        "--output",
        "-o",
        help="Output file path",
    )

    args = parser.parse_args()

    if args.command == "transcribe":
        print(f"Transcribing {args.audio} (language={args.language})...")
        if args.output:
            print(f"Result will be saved to {args.output}")
        return 0

    parser.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
