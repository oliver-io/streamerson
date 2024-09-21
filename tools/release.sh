#!/usr/bin/env bash
set -e

# Default to "core" if no arguments are provided
TARGETS=("${@:-core}")

# Execute a build to ensure nothing is broken
npm run build

for TARGET in "${TARGETS[@]}"; do
    # cd into the dir and update version
    cd "packages/$TARGET" && npm version patch --no-git-tag-version
    cd ../..
done

# Rebuild after updating versions
npm run build

# Publish each target
for TARGET in "${TARGETS[@]}"; do
    cd "dist/packages/$TARGET"
    npm publish --access public --non-interactive
    cd ../../..
done

# Display the new versions
echo "Published versions installation:"
for TARGET in "${TARGETS[@]}"; do
    VERSION=$(node -p "require('./packages/$TARGET/package.json').version")
    echo "npm install $TARGET@$VERSION"
done
