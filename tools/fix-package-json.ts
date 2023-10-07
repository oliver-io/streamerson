import fs from 'fs';
import {getPackageMetadata} from "./get-package-metadata";
const [_, __, target] = process.argv;

if (!target) {
    throw new Error("No target specified");
}

try {
    console.log(`Fixing package.json in ${target}`)
    const { packageJson, packageJsonPath } = getPackageMetadata(target);
    if (packageJson.source.includes('dist/')) {
        packageJson.source = packageJson.source.replace('dist/', '');
        if (packageJson.source.endsWith('.ts')) {
            packageJson.source = packageJson.source.replace('.ts', '.js');
        }
    }

    if (packageJson.types.includes('dist/')) {
        packageJson.types = packageJson.types.replace('dist/', '');
        if (packageJson.types.endsWith('.ts')) {
            packageJson.types = packageJson.types.replace('.ts', '.js');
        }
    }

    if (packageJson.main.includes('dist/')) {
        packageJson.main = packageJson.main.replace('dist/', '');
        if (packageJson.main.endsWith('.ts')) {
            packageJson.main = packageJson.main.replace('.ts', '.js');
        }
    }

    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));
} catch(err) {
    console.error(err);
    throw new Error("Cannot read package.json");
}