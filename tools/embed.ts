import fs from 'fs';
import path from 'path';
import {exec, execSync} from 'child_process';
import {green, yellow} from 'colors';
import {glob} from 'glob';
import minimist from 'minimist';
const commandLineArgs = minimist(process.argv.slice(2));
const directoryDenyList = [".yalc", "dist/**/*", "tmp/**/*", "node_modules", "deps", '**/node_modules/**/*', "**/LICENSE.md"]

const supportedFileExtensions = [
    ".ts",
    ".js",
    ".md",
];

async function getAllCodeFiles(dir?: string) {
    const codeFiles:Array<string> = (await glob(dir ?? `packages/**/*.ts`, { ignore: directoryDenyList }));
    return codeFiles;
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
  let i=0, j=0;

  try {
    let readme = (await fs.promises.readFile(options.absoluteFilePath)).toString();
    const beginTags = readme.match(/<!-- BEGIN-CODE:(\s+)(.*)(\s)+-->/g);
    const endTags = readme.match(/<!-- END-CODE:(\s+)(.*)(\s)+-->/g);
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

    fs.writeFileSync(options.absoluteFilePath, readme);
  } catch(err) {
    console.error(err, `Failed embedding for file: ${options.relativeFilePath}`);
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

export async function generateCodeDocs(options: AddContentArgs):Promise<string> {
    return new Promise<string>((resolve)=>{
        let buf = '';
        const destPath = options.relativeFilePath.replace(/\\/g, '/') + '/../_API.md';
        const inputPath = options.relativeFilePath.replace(/\\/g, '/');
        const command = `tsdoc --src=${inputPath} --dest=${destPath}`;
        const child = exec(command);
        if (child.stdout) {
            child.stdout.on('data', (d)=>{
                buf += d;
            });
        }
        child.on('exit', (code)=>{
            resolve(buf.toString());
        });
    });
}

export async function findAllMarkdown() {
    try {
        const testFiles:Array<string> = (await glob([`**/*.md`, '!LICENSE.md'], { ignore: directoryDenyList }));
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

async function enrichArtilleryReports() {
  const files = [
    ...await glob('./packages/**/_reports/loadtest/*.json'),
    ...await glob('./packages/**/_reports/gcp/*.json')
  ];
  let generated = 0;
  for (const file of files) {
    execSync(`artillery report ${file} --output ${file.replace('.json', '.html')}`);
    generated++;
  }
  return generated;
}

async function cli() {
    const artilleryHTMLGenerated = await enrichArtilleryReports();
    const codeFiles = await getAllCodeFiles();
    const annotatedFiles = (await Promise.all(codeFiles.map(async (codePath)=>{
        try {
            const codeText = (await fs.promises.readFile(codePath)).toString();
            if(codeText.includes('@param')) {
                return codePath;
            } else {
                return false;
            }
        } catch(err) {
            return false;
        }
    }))).filter(f=>!!f)

    await Promise.all(annotatedFiles.map(async eligibleFile=>{
        await generateCodeDocs({
            absoluteFilePath: eligibleFile! as string,
            relativeFilePath: path.relative(process.cwd(), eligibleFile! as string)
        });
    }));

    const files = await findAllMarkdown();
    const result = await Promise.all(files.map(enrichFile));
    if (commandLineArgs.summary) {
        let doctoc = 0;
        let embed = 0;
        for (const item of result) {
            doctoc+=item.doctoc;
            embed+=item.embeddings;
        }

        console.log(((doctoc + embed) ? green('✓ ') : yellow('x ')) + `Updated ${
            doctoc ? green(doctoc.toString()) : yellow('0')
        } DocTocs, ${
          artilleryHTMLGenerated ? green(artilleryHTMLGenerated.toString()) : yellow('0')
        } Artillery Reports, ${
            embed ? green(embed.toString()) : yellow('0')
        } Embeddings, and ${
          annotatedFiles.length ? green(annotatedFiles.length.toString()) : yellow('0')
        } TSDocs`);
    }
}

if (commandLineArgs.write || commandLineArgs.w) {
    cli().catch(console.error);
}
