"""Create a reproducible local QA clip with known, baked-in touch gestures and audio."""
import json
import pathlib
import subprocess
import tempfile
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'public/cursor/Examples/phone-demo-raw.mp4'
OUTPUT = ROOT / 'public/cursor/Examples/mobile-touch-demo.mp4'

def touch(time):
    if 1 <= time <= 2.2:
        return .30, .37
    if 3 <= time <= 4.3:
        progress = (time - 3) / 1.3
        return .20 + .50 * progress, .64 - .10 * progress
    if 5.2 <= time <= 6.4:
        progress = (time - 5.2) / 1.2
        return .80 - .50 * progress, .77 + .04 * progress
    return None

if __name__ == '__main__':
    metadata = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,avg_frame_rate', '-of', 'json', str(SOURCE)]))['streams'][0]
    width, height = metadata['width'], metadata['height']
    num, den = map(int, metadata['avg_frame_rate'].split('/'))
    fps = num / den
    if not 1 <= fps <= 120:
        raise RuntimeError('Unexpected source frame rate.')
    with tempfile.TemporaryDirectory() as directory:
        silent = pathlib.Path(directory) / 'touch-video.mp4'
        decode = subprocess.Popen(['ffmpeg', '-v', 'error', '-i', str(SOURCE), '-an', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], stdout=subprocess.PIPE)
        encode = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{width}x{height}', '-r', str(fps), '-i', '-', '-an', '-c:v', 'libx264', '-crf', '19', '-pix_fmt', 'yuv420p', str(silent)], stdin=subprocess.PIPE)
        index = 0
        while True:
            data = decode.stdout.read(width * height * 3)
            if not data:
                break
            if len(data) != width * height * 3:
                raise RuntimeError('Incomplete source frame.')
            image = Image.frombytes('RGB', (width, height), data)
            point = touch(index / fps)
            if point:
                x, y = point[0] * width, point[1] * height
                ImageDraw.Draw(image, 'RGBA').ellipse((x - 17, y - 17, x + 17, y + 17), fill=(235, 235, 235, 210), outline=(130, 130, 130, 225), width=2)
            encode.stdin.write(image.tobytes())
            index += 1
        encode.stdin.close()
        if decode.wait() or encode.wait():
            raise RuntimeError('Sample video encoding failed.')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(silent), '-i', str(SOURCE), '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', str(OUTPUT)], check=True)
    print(f'Created {OUTPUT.name}: {index} frames, three known touch gestures, original audio.')
