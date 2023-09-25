import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
export function getPackageMetadata(target: string) {
    if (!target) {
        throw new Error("No target specified");
    }

    try {
        // const nxJson = '{"root": "packages/core" }'
        const nxJson = execSync(`nx show project ${target} --json`).toString();
        const nxJsonParsed = JSON.parse(nxJson);
        const projectRootPath = nxJsonParsed.root as string;
        const projectDirectory = path.resolve(projectRootPath);
        const packageJsonPath = path.resolve(projectDirectory, 'package.json');
        const packageJsonBuffer = fs.readFileSync(packageJsonPath);
        const packageJson = JSON.parse(packageJsonBuffer.toString());
        return {
            packageJson,
            packageJsonPath,
            projectDirectory,
        }
    } catch(err) {
        console.error(err);
        throw new Error("Cannot read package.json");
    }
}