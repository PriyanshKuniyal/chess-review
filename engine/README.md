# engine/

Stockfish lives here. It isn't committed to the repository; `npm run setup` downloads the
official build for your OS into this folder (release zips already include it).

The server uses the first executable named `stockfish*` it finds in here. To use a different
build, either drop it into this folder or set `STOCKFISH_PATH` to its full path.
