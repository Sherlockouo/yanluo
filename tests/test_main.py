from asr_cli.main import main


def test_version(capsys):
    try:
        main(["--version"])
    except SystemExit as exc:
        assert exc.code == 0
    captured = capsys.readouterr()
    assert "asr-cli" in captured.out
    assert "0.1.0" in captured.out
