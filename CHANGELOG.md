# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.5.0] - 2026-10-25

### Added
- **Blue arrow for the engine's reply**: when you play your own moves off the game, a blue arrow
  shows the best move for the side to move next, so you can keep exploring without asking for it.
- **L-shaped arrows for knight moves**, like chess.com.

### Changed
- **New eval bar**: wider (it grows with the board), White's share slides smoothly to each new
  evaluation while the number counts toward it, a tick marks equality, and the edge flashes in
  the move's color on brilliant moves, great moves, misses, mistakes and blunders. A light sweeps
  along the bar while the engine is still thinking about a move you played, and hovering it
  says who is better ("+1.28: White is slightly better"). Play the coach uses the same bar.
- Arrows are a little more opaque, so short ones stay visible under the move badges.

## [1.4.1] - 2026-10-24

### Fixed
- The coach could credit a move to the wrong side, e.g. call Black's better alternative "White's
  counterplay". Every move it's told about now says whose move it is (Black's best move was f6,
  White's best reply is Kd1), lines carry move numbers (16...f6 17.O-O), and each sentence is
  checked before it's shown. If one credits a move to the wrong side, the coach rewrites the
  explanation; if it's still wrong, you get the built-in explanation instead.
- Saved reviews are re-analysed once so they pick up the corrected explanations.

## [1.4.0] - 2026-10-24

### Added
- **Puzzles from your own mistakes** (new Puzzles tab): every position where you made a mistake,
  blunder or miss in your recent games becomes a puzzle: find a better move than the one you
  played. Answers are checked by Stockfish, so any move about as good as the best one counts.
  - Themed by what went wrong: find the tactic, spot the danger, keep your pieces safe, stop the
    mate, find the checkmate.
  - After each puzzle the coach explains why the right move works and why your game move didn't,
    with clickable lines. Hints, show solution and skip are there when you're stuck.
  - Spaced repetition, saved in your profile: puzzles you solve first try come back after 1, 3, 7,
    14 and 30 days; missed ones come back the same day. Recent games and your biggest weak spots
    come first.

## [1.3.0] - 2026-10-24

### Added
- **Play the coach**: a sparring game against a coach that adapts to you.
  - Enter your Chess.com or Lichess username (or just search your games in Review) and the coach
    learns from your recent games in the background: your weak spots (pieces left hanging, tactics
    missed or walked into, missed mates, opening/middlegame/endgame errors), the openings that cost
    you points, and your strength.
  - Learning is saved on your PC and picks up where it left off: each launch only analyses games
    played since last time. Recent games count more: a game from 30 days ago weighs half as much.
  - The coach plays a little above your level, steers into openings you've been losing in, sets up
    tactics for you to find if you tend to miss them, pressures loose pieces if you leave them
    hanging, and trades down if endgames are your weak spot. Or pick a focus yourself.
  - Every move you play is graded and explained (with clickable ideas), with "this is a pattern
    from your games" notes, threat warnings, three-step hints, take-backs, and an end-of-game
    summary. One click sends the game to the full review.

## [1.2.0] - 2026-10-24

### Added
- **Clickable ideas in explanations**: phrases like "loses a knight", "wins a pawn", "checkmate",
  "fork" or "hanging", and any move the coach mentions, are highlighted. Click one to play out the
  line behind it on the board, so an idea that only pays off a few moves later is easy to see.
- **Promotion picker**: when you promote a pawn on the board (exploring or in Retry mistakes),
  choose queen, knight, rook or bishop instead of always getting a queen.

### Fixed
- Explanations now lead with a missed checkmate instead of a smaller material detail.
- Games that start from a set-up position (FEN) no longer show a full army as "captured".

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
