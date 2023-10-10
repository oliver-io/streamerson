import fs from 'fs';
import path from 'path';
import {exec} from 'child_process';
import {green, yellow} from 'colors';
import {glob} from 'glob';
import minimist from 'minimist';
const commandLineArgs = minimist(process.argv.slice(2));
const directoryDenyList = [".yalc", "node_modules", "deps"]

const supportedFileExtensions = [
    ".ts",
    ".js",
    ".md",
];

function* getAllCodeFiles(dir?: string): Generator<string> {
    const codeFiles = fs.readdirSync(`./${dir ? '/' + dir : ''}`, {withFileTypes: true});
    for (const file of codeFiles) {
        if (file.isDirectory() && !directoryDenyList.includes(file.name)) {
            yield* getAllCodeFiles(file.name)
        } else if (file.isFile() && supportedFileExtensions.includes(path.extname(file.name))) {
            yield `${dir}/${file.name}`
        }
    }
}

type AddContentArgs = {
    relativeFilePath: string,
    absoluteFilePath: string
};

export function tagWithType(content: string, file: string) {
    const type = path.extname(file).replace('.', '');
    if (!supportedFileExtensions.includes(`.${type}`)) {
        throw new Error(`Unsupported file type ${type}`)
    }
    switch(type) {
        case 'ts':
            return '```typescript\n' + content + '\n```';
        default:
            return `\n${content}\n`;
    }
}

export async function addEmbeddings(options: AddContentArgs) {
    let readme = (await fs.promises.readFile(options.absoluteFilePath)).toString();
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
            const newContent = (await fs.promises.readFile(filePath)).toString();
            const embeddedHref = `[**${
                fileReference.substring(fileReference.lastIndexOf('/')+1, fileReference.length)
            }**](${fileReference})`;
            const firstHalf = readme.substring(0, beginEmbedIndex + beginTag.length);
            const secondHalf = readme.substring(endEmbedIndex, readme.length);
            readme = `${firstHalf}\n${embeddedHref}\n${tagWithType(newContent, filePath)}\n${secondHalf}`;
        }
    }

    return {
        path,
        embedded: i
    }
}

export async function addTableOfContents(options: AddContentArgs) {
    return new Promise((resolve)=>{
        let buf = '';
        const child = exec(`doctoc ${options.absoluteFilePath} --github`);
        if (child.stdout) {
            child.stdout.on('data', (d)=>{
                buf += d;
            });
        }
        child.on('exit', (code)=>{
            const output = buf.toString().trim();
            resolve(
                output.includes('Everything is OK') &&
                output.includes('will be updated')
            );
        });
    });
}

export async function findAllReadMes() {
    try {
        const testFiles:Array<string> = (await glob(`**/README.md`, { ignore: '**/node_modules/**/*' }));
        return testFiles;
    } catch(err) {
        console.error(err);
        throw new Error("Cannot find readme locations");
    }
}

async function enrichFile(target: string) {
    const pathArgs = {
        relativeFilePath: path.relative(process.cwd(), target),
        absoluteFilePath: path.resolve(target)
    };
    const [addEmbeds, addTOC] = await Promise.all([
        addEmbeddings(pathArgs),
        addTableOfContents(pathArgs)
    ]);


    if ((commandLineArgs.verbose || commandLineArgs.v) || !commandLineArgs.summary) {
        if ((addEmbeds.embedded || addTOC) || (commandLineArgs.verbose || commandLineArgs.v)) {
            console.group(pathArgs.absoluteFilePath);
            console.log(`${addEmbeds.embedded ? green('✓') : yellow('X')} ${
                addEmbeds.embedded ? 'Added ' + addEmbeds.embedded + ' Embeddings' : 'No Embeddings Added'
            };`);
            console.log(`${addTOC ? green('✓') : yellow('X')} DocToc Generated);`);
            console.groupEnd();
        }
    }

    return {
        embeddings: addEmbeds.embedded,
        doctoc: addTOC ? 1 : 0
    }
}

async function cli() {
    const files = await findAllReadMes();
    const result = await Promise.all(files.map(enrichFile));
    if (commandLineArgs.summary) {
        let doctoc = 0;
        let embed = 0;
        for (const item of result) {
            doctoc+=item.doctoc;
            embed+=item.embeddings;
        }

        console.log(((doctoc + embed) ? green('✓ ') : yellow('x ')) + `Added ${
            doctoc ? green(doctoc.toString()) : yellow('0')
        } DocTocs and ${
            embed ? green(embed.toString()) : yellow('0')
        } Embeddings`);
    }
}

if (commandLineArgs.write || commandLineArgs.w) {
    cli().catch(console.error);
}