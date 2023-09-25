#bin/bash
# Get the first argument from the command line
# This is the package name of the bundle to publish
PACKAGE_NAME=$1

# Find a directory in `./packages` with the `name` field
# Parse the JSON output of "nx show project $PACKAGE_NAME" using NODE
# Then get the "root" field from the JSON output
DIRECTORY=$(node -e "
  console.log(
    JSON.parse(require('child_process')
    .execSync('nx show project $PACKAGE_NAME --json')
    .toString())
    .root)
")

## First we will run the relevant yarn commands to build our `dist` directory:
nx build $PACKAGE_NAME
#
## Then we will put a copy of the package.json file in the `dist` directory
cp $DIRECTORY/package.json $DIRECTORY/dist/package.json
#
## Now we run the node script to mess with the package.json file:
tsx ./tools/fix-package-json "$DIRECTORY/dist/package.json"

cp LICENSE.md $DIRECTORY/dist/LICENSE.md