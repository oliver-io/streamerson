import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { green, yellow } from 'colors';

const directoryDenyList = [".yalc", "node_modules", "deps"]

function* getAllCodeFiles(dir?: string): Generator<string> {
    const codeFiles = fs.readdirSync(`./${dir ? '/' + dir : ''}`, {withFileTypes: true});
    for (const file of codeFiles) {
        if (file.isDirectory() && !directoryDenyList.includes(file.name)) {
            yield* getAllCodeFiles(file.name)
        } else if (file.isFile() && (path.extname(file.name) === ".ts")) {
            yield `${dir}/${file.name}`
        }
    }
}

type AddContentArgs = {
    relativeFilePath: string,
    absoluteFilePath: string
};

function addContent(options: AddContentArgs) {
    let readme = fs.readFileSync(options.absoluteFilePath).toString();
    const beginTags = readme.match(/<!-- BEGIN-CODE:(\s+)(.*)(\s)+-->/g);
    const endTags = readme.match(/<!-- END-CODE:(\s+)(.*)(\s)+-->/g);
    let i=0, j=0;
    const tags = (beginTags?.length ?? 1);
    if (tags && beginTags?.[0] && endTags?.[0]) {
        for (; i < tags; i++, j++) {
            const beginTag = beginTags?.[i];
            const endTag = endTags?.[j];
            if (!beginTag || !endTag) {
                throw new Error('Tag Mismatch');
            }
            const fileReference = beginTag.replace('<!-- BEGIN-CODE:', '').replace('-->', '').trim();
            const filePath = path.resolve(`${options.absoluteFilePath}/..`, fileReference);
            const beginEmbedIndex = readme.indexOf(beginTag);
            const endEmbedIndex = readme.indexOf(endTag);
            const newContent = fs.readFileSync(filePath).toString();
            const embeddedHref = `[**${
                fileReference.substring(fileReference.lastIndexOf('/')+1, fileReference.length)
            }**](${fileReference})`;
            const firstHalf = readme.substring(0, beginEmbedIndex + beginTag.length);
            const secondHalf = readme.substring(endEmbedIndex, readme.length);
            readme = `${firstHalf}\n${embeddedHref}\n${'```typescript\n' + newContent + '\n```'}\n${secondHalf}`;
        }
    }

    fs.writeFileSync(options.absoluteFilePath, readme);
    const log = `Embedding ${i ? 'successful for ' + i + ' blocks' : 'skipped'} for ${options.absoluteFilePath}`;
    console.log(i ? green(log) : yellow(log));
}


async function cli() {
    const [_, __, file] = process.argv;
    if (!file) {
        console.log('Usage: tsx embed.ts <path> <file> [contentPath]')
        process.exit(1);
    }

    const absoluteFilePath = path.resolve(process.cwd(), file);
    await fs.promises.stat(absoluteFilePath);
    addContent({
        relativeFilePath: file,
        absoluteFilePath,
    });
    const doctocResult = execSync(`doctoc ${absoluteFilePath} --github`).toString();
    if (doctocResult.includes('Everything is OK')) {
        console.log(green('Doctoc successful'));
    }
}

cli().catch(console.error);