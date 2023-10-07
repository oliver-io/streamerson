import { glob } from 'glob';
import { execSync } from 'child_process';
import path from 'path';
export async function findAllReadMes() {
    try {
        const testFiles:Array<string> = (await glob(`**/README.md`, { ignore: '**/node_modules/**/*' }));
        return testFiles;
    } catch(err) {
        console.error(err);
        throw new Error("Cannot find readme locations");
    }
}

async function cli() {
    const files = await findAllReadMes();
    for (const file of files) {
        const embedScriptPath = path.resolve('./tools/embed.ts')
        // const localFilePath = path.resolve(file, '..');
        // const localFileToEmbed = path.relative(embedScriptPath, localFilePath);
        // // console.log(`tsx ${embedScriptPath} ${localFilePath}`);
        console.log(execSync(`tsx ${embedScriptPath} README.md`, { cwd: path.resolve(file, '..')}).toString());
    }
}

cli().catch(console.error)