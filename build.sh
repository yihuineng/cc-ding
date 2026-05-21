#!/bin/zsh

rm -rf ./dist

./node_modules/typescript/bin/tsc

#cp -r ./resource ./dist/resource
rm -rf ./dist/test

grep -rl 'ts-node' ./dist/bin | xargs sed -i '' 's/ts-node/node/g'

# Minify JavaScript files
echo "Minifying JavaScript files..."
./node_modules/.bin/javascript-obfuscator ./dist --output ./dist \
  --compact true \
  --simplify true

