# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-24

First public release.

### Added
- Game review: every move classified as Brilliant, Great, Best, Excellent, Good, Book,
  Inaccuracy, Mistake, Miss, Blunder or Forced, with accuracy, estimated game rating and
  per-phase accuracy.
- Written explanations for every move and a game summary from a local AI coach (Ollama),
  grounded in engine lines and detected tactics (forks, hanging pieces, material won, mates).
- Load games from **Chess.com** or **Lichess** by username, or paste/drop a **PGN** file.
- Retry mistakes: replay your inaccuracies, mistakes and blunders as puzzles.
- Animated board with classification badges, colored move highlights, best-move arrows,
  "Show best", autoplay, eval bar and clickable eval graph.
- Wooden piece sounds for moves, captures, checks and castling.
- Windows launcher with a splash screen; the server stops on its own when the window closes.
- In-app coach setup that downloads the model through Ollama, plus an update notice when a new
  release is out.
