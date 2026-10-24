# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-24

### Added
- **Analysis board while reviewing**: drag any piece to try your own move. The engine grades it
  (Best, Mistake, Blunder…), updates the eval bar and best-move arrow, and the coach explains it.
  Your moves appear as a variation in the move list; keep playing both sides, step through it with
  the arrow keys, and press Esc or ✕ to return to the game.
- **Show best** now plays the engine's whole line as a variation you can step through, and
  **Engine line** does the same for the expected continuation after a good move.
- Board coordinates (1–8, a–h) drawn inside the edge squares, like chess.com.

### Fixed
- The board's light and dark squares were swapped (a8 and h1 are light again).
- The coach no longer claims material is lost when the evaluation doesn't back it up, and no longer
  starts explanations with a stray "KEY POINT:" label.

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
