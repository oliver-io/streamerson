#!/usr/bin/env bash
set -e

# Get the list of affected projects
RAW_TARGETS=$(nx print-affected --select=projects)

# Convert comma-separated list to array and exclude 'monorepo'
IFS=',' read -ra ALL_TARGETS <<< "$RAW_TARGETS"
TARGETS=()
for TARGET in "${ALL_TARGETS[@]}"; do
  TARGET=$(echo "$TARGET" | xargs) # Trim whitespace
  if [ "$TARGET" != "@streamerson/monorepo" ]; then
    TARGETS+=("$TARGET")
    echo "TARGET: $TARGET"
  fi
done

# Default to "core" if no affected projects are found
if [ ${#TARGETS[@]} -eq 0 ]; then
  TARGETS=("core")
fi

# Execute a build to ensure nothing is broken
npm run build

# Publish each target to yalc
for TARGET in "${TARGETS[@]}"; do
    cd "dist/packages/${TARGET}"
    yalc publish
    cd ../../..
done

# Display the new versions
echo "Published versions installation:"
for TARGET in "${TARGETS[@]}"; do
    VERSION=$(node -p "require('./packages/${TARGET}/package.json').version")
    echo "yalc add ${TARGET}@${VERSION}"
done
