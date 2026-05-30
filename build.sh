#!/bin/zsh

rm -rf ./dist

./node_modules/typescript/bin/tsc

cp -r ./resource ./dist/resource
rm -rf ./dist/test

grep -rl 'ts-node' ./dist/bin | xargs sed -i '' 's/ts-node/node/g'

# Minify JavaScript files with esbuild
echo "Minifying JavaScript files..."
find ./dist -name '*.js' -exec sh -c '
  ./node_modules/.bin/esbuild "$1" --minify --allow-overwrite --target=es2020 --platform=node --outfile="$1"
' _ {} \;

