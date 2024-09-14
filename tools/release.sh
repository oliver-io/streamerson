#!/usr/bin/env bash
set -e

TARGET="${1:-core}"

## execute a build sos to not continue on anything broken:
yarn build

## cd into the dir:
cd packages/$TARGET && yarn version --patch --no-git-tag-version

## rebuild:
cd ../../
yarn clean

## publish:
cd dist/packages/$TARGET
yarn publish --access public --non-interactive
