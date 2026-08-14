// 长跑版：先立刻吐出要验的东西，再挂住 6 秒，好让 SSE 有时间连上来。
process.stdout.write('\u001b[32mstart\u001b[0m\n')
process.stdout.write('10%\r')
setTimeout(() => process.stdout.write('50%\r'), 300)
setTimeout(() => process.stdout.write('100%\n'), 600)
setTimeout(() => process.stdout.write('done\n'), 900)
setTimeout(() => process.exit(0), 6000)
