min ファイルの作成コマンド

```sh
# 元ファイルは https://dashboardicons.com/icons/pi-coding-agent より入手
# ファイル圧縮、背景色付与、base64
magick pi-coding-agent.png -resize 50% /tmp/pi-coding-agent.half.png \
&& magick /tmp/pi-coding-agent.half.png -background '#181818' -alpha remove -alpha off /tmp/pi-coding-agent.half.bg.png \
&& pngquant --quality=65-85 --strip --force --output /tmp/pi-coding-agent.min.png /tmp/pi-coding-agent.half.bg.png \
&& base64 -w 0 /tmp/pi-coding-agent.min.png | tee >(clip)
```
