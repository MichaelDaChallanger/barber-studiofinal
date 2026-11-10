"""Malá náhrada modulu `brotli` pre fontTools (WOFF2): kompresiu robí Node.js (zlib.brotli*).
Používa ju iba tools/build_fonts.py, keď nie je nainštalovaný balík brotli."""
import subprocess

MODE_GENERIC, MODE_TEXT, MODE_FONT = 0, 1, 2

_JS_COMPRESS = (
    "const z=require('zlib');const c=[];process.stdin.on('data',d=>c.push(d));"
    "process.stdin.on('end',()=>{const b=Buffer.concat(c);process.stdout.write(z.brotliCompressSync(b,{params:{"
    "[z.constants.BROTLI_PARAM_MODE]:z.constants.BROTLI_MODE_FONT,[z.constants.BROTLI_PARAM_QUALITY]:11,"
    "[z.constants.BROTLI_PARAM_SIZE_HINT]:b.length}}));});"
)
_JS_DECOMPRESS = (
    "const z=require('zlib');const c=[];process.stdin.on('data',d=>c.push(d));"
    "process.stdin.on('end',()=>process.stdout.write(z.brotliDecompressSync(Buffer.concat(c))));"
)


def _node(script, data):
    return subprocess.run(["node", "-e", script], input=bytes(data), stdout=subprocess.PIPE, check=True).stdout


def compress(data, mode=MODE_GENERIC, quality=11, lgwin=22, lgblock=0):
    return _node(_JS_COMPRESS, data)


def decompress(data):
    return _node(_JS_DECOMPRESS, data)
