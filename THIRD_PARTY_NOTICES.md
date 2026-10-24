# Third-party notices

Chess Review is licensed under the GNU GPL v3 or later (see `LICENSE`). It includes or downloads
the following third-party components.

| Component | Used for | License | Source |
| --- | --- | --- | --- |
| [Stockfish](https://stockfishchess.org/) 19 | Chess engine (bundled in release zips, downloaded by `npm run setup`) | GPL-3.0 | https://github.com/official-stockfish/Stockfish/tree/sf_19 |
| [chessground](https://github.com/lichess-org/chessground) | Interactive board, includes the cburnett piece set | GPL-3.0-or-later | https://github.com/lichess-org/chessground |
| [chess.js](https://github.com/jhlywa/chess.js) | Move generation, PGN parsing | BSD-2-Clause | https://github.com/jhlywa/chess.js |
| [lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) | Opening book (`data/*.tsv`) | CC0-1.0 | https://github.com/lichess-org/chess-openings |
| [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds) | Piece sounds (`public/sounds/*.ogg`) | CC0-1.0 | https://kenney.nl/assets/impact-sounds |
| [Node.js](https://nodejs.org/) | Runtime (bundled in release zips as `runtime/node.exe`) | MIT and others, see `runtime/LICENSE.txt` | https://github.com/nodejs/node |

The AI coach model (default `qwen3:4b-instruct`, Apache-2.0) is not included. Ollama downloads it
to your machine when you set up the coach.

Stockfish's full source code for the bundled version is available at the link above. The release
zip also contains Stockfish's own license (`engine/stockfish/Copying.txt`) and source tree.

Chess Review is not affiliated with, endorsed by, or connected to Chess.com or Lichess. It uses
their public APIs to fetch games that are already public.
