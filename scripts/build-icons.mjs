// Renders the SVG sources in build/ into the PNG and ICO files the app and installer use.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import sharp from 'sharp'
import pngToIco from 'png-to-ico'

const render = async (svgPath, size) =>
  sharp(await readFile(svgPath), { density: Math.max(72, (size / 64) * 72 * 2) })
    .resize(size, size)
    .png()
    .toBuffer()

await mkdir('resources', { recursive: true })

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoPngs = []
for (const size of icoSizes) icoPngs.push(await render('build/icon.svg', size))
await writeFile('build/icon.ico', await pngToIco(icoPngs))
await writeFile('build/icon.png', await render('build/icon.svg', 512))
await writeFile('resources/icon.png', await render('build/icon.svg', 256))

for (const [name, src] of [['tray', 'build/tray.svg'], ['tray-attention', 'build/tray-attention.svg']]) {
  await writeFile(`resources/${name}.png`, await render(src, 16))
  await writeFile(`resources/${name}@2x.png`, await render(src, 32))
}
console.log('Icons written to build/ and resources/')
