import os
import tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Monkey patch for Pillow 10+ compatibility with MoviePy 1.0.3
if not hasattr(Image, 'ANTIALIAS'):
    Image.ANTIALIAS = Image.LANCZOS

from moviepy.editor import (
    VideoFileClip, ImageClip, AudioFileClip,
    CompositeVideoClip, CompositeAudioClip,
    ColorClip, TextClip, concatenate_videoclips
)
import asyncio
import edge_tts

class VideoProcessor:
    def __init__(self, output_dir="./output", temp_dir="./temp"):
        self.output_dir = output_dir
        self.temp_dir = temp_dir
        os.makedirs(self.output_dir, exist_ok=True)
        os.makedirs(self.temp_dir, exist_ok=True)

    def create_text_image(self, text, fontsize=50, color='white', bg_color=None, size=None, font_path=None):
        """
        Creates a PIL Image with text. simpler than relying on ImageMagick.
        """
        # Estimate size if not provided
        if size is None:
             # Heuristic size estimation or default
             size = (1920, 100) # Wide strip
             if len(text) > 50:
                 size = (1080, 1920) # Full screen vertical?

        # Create transparent image
        img = Image.new('RGBA', size, (0, 0, 0, 0) if bg_color is None else bg_color)
        draw = ImageDraw.Draw(img)

        # Load font (try default or specific)
        try:
            # Try to load a standard font if available, or default
            font = ImageFont.truetype("arial.ttf", fontsize)
        except IOError:
            try:
                # Fallback for linux/other systems
                font = ImageFont.truetype("DejaVuSans.ttf", fontsize)
            except IOError:
                font = ImageFont.load_default()

        # Calculate text position (Center)
        if font:
            text_bbox = draw.textbbox((0, 0), text, font=font)
            text_width = text_bbox[2] - text_bbox[0]
            text_height = text_bbox[3] - text_bbox[1]
            x = (size[0] - text_width) / 2
            y = (size[1] - text_height) / 2
            draw.text((x, y), text, font=font, fill=color)

        return np.array(img)

    def render_timeline(self, timeline_data, output_filename="output.mp4"):
        """
        Renders a video from a timeline JSON object.
        """
        fmt = timeline_data.get("format", {"width": 1080, "height": 1920, "fps": 30})
        width = fmt.get("width", 1080)
        height = fmt.get("height", 1920)
        fps = fmt.get("fps", 30)

        video_clips = []
        audio_clips = []

        tracks = timeline_data.get("tracks", [])

        for track in tracks:
            track_type = track.get("type", "video")
            clips_data = track.get("clips", [])

            for clip_data in clips_data:
                clip_type = clip_data.get("type", "video") # video, image, text
                source = clip_data.get("source")
                start_time = clip_data.get("start", 0) # In source
                end_time = clip_data.get("end", None) # In source
                duration = clip_data.get("duration", None)
                position_on_timeline = clip_data.get("position", 0) # Where it appears in result

                mp_clip = None

                try:
                    if track_type == "audio":
                        if source and os.path.exists(source):
                            mp_clip = AudioFileClip(source)
                            if end_time:
                                mp_clip = mp_clip.subclip(start_time, end_time)
                            elif duration:
                                mp_clip = mp_clip.subclip(start_time, start_time + duration)

                            mp_clip = mp_clip.set_start(position_on_timeline)
                            # Volume
                            if "volume" in clip_data:
                                mp_clip = mp_clip.volumex(clip_data["volume"])

                            audio_clips.append(mp_clip)

                    else: # video or overlay track
                        if clip_type == "video":
                            if source and os.path.exists(source):
                                mp_clip = VideoFileClip(source)
                                if end_time:
                                    mp_clip = mp_clip.subclip(start_time, end_time)
                                elif duration:
                                    mp_clip = mp_clip.subclip(start_time, start_time + duration)
                                else:
                                    mp_clip = mp_clip.subclip(start_time) # To end

                        elif clip_type == "image":
                            if source and os.path.exists(source):
                                mp_clip = ImageClip(source)
                                if duration:
                                    mp_clip = mp_clip.set_duration(duration)

                        elif clip_type == "text":
                            content = clip_data.get("content", "")
                            fontsize = clip_data.get("fontsize", 50)
                            color = clip_data.get("color", "white")
                            # Generate text image using Pillow
                            img_array = self.create_text_image(
                                content, fontsize=fontsize, color=color,
                                size=(width, height) # Create full frame text layer for simplicity
                            )
                            mp_clip = ImageClip(img_array)
                            if duration:
                                mp_clip = mp_clip.set_duration(duration)

                        if mp_clip:
                            # Resize/Positioning
                            if clip_type in ["video", "image"]:
                                # Optional: Add "resize_mode": "fill" | "fit"
                                # For now, resize to fit width
                                mp_clip = mp_clip.resize(width=width)

                            mp_clip = mp_clip.set_start(position_on_timeline)

                            # Layer Positioning
                            clip_pos = clip_data.get("pos", ("center", "center"))
                            mp_clip = mp_clip.set_position(clip_pos)

                            video_clips.append(mp_clip)

                except Exception as e:
                    print(f"Error processing clip {clip_data}: {e}")
                    continue

        # Create Composite Video
        # First clip usually background, but we can set a black background ColorClip
        # Calculate max duration
        max_duration = 0
        for c in video_clips:
            end = c.start + c.duration
            if end > max_duration:
                max_duration = end
        for c in audio_clips:
            end = c.start + c.duration
            if end > max_duration:
                max_duration = end

        if max_duration == 0:
            max_duration = 5 # Default if empty

        bg_clip = ColorClip(size=(width, height), color=(0,0,0), duration=max_duration)

        final_video = CompositeVideoClip([bg_clip] + video_clips, size=(width, height))

        if audio_clips:
            # If video clips have audio, include them
            original_audio = final_video.audio
            all_audios = [original_audio] if original_audio else []
            all_audios.extend(audio_clips)
            final_audio = CompositeAudioClip(all_audios)
            final_video = final_video.set_audio(final_audio)

        output_path = os.path.join(self.output_dir, output_filename)
        final_video.write_videofile(output_path, fps=fps, codec="libx264", audio_codec="aac")

        # Cleanup
        final_video.close()
        for c in video_clips:
            try: c.close()
            except: pass
        for c in audio_clips:
            try: c.close()
            except: pass

        return output_path

    async def generate_script_video(self, script, voice="en-US-AnaNeural", bg_images=None):
        """
        Generates a video from a script.
        """
        sentences = [s.strip() for s in script.split('.') if s.strip()]
        clips = []

        for i, sentence in enumerate(sentences):
            # Generate Audio
            audio_file = os.path.join(self.temp_dir, f"tts_{i}.mp3")
            communicate = edge_tts.Communicate(sentence, voice)
            await communicate.save(audio_file)

            audio_clip = AudioFileClip(audio_file)
            duration = audio_clip.duration + 0.5 # Add small pause

            # Visual
            if bg_images and i < len(bg_images) and os.path.exists(bg_images[i]):
                visual_clip = ImageClip(bg_images[i]).set_duration(duration)
                visual_clip = visual_clip.resize(height=1080)
                visual_clip = visual_clip.set_position("center")
            else:
                # Random color or alternating
                colors = [(50, 50, 150), (50, 150, 50), (150, 50, 50)]
                color = colors[i % len(colors)]
                visual_clip = ColorClip(size=(1920, 1080), color=color, duration=duration)

            # Add Text Overlay
            txt_img = self.create_text_image(sentence, fontsize=60, size=(1800, 200), bg_color=(0,0,0,128))
            txt_clip = ImageClip(txt_img).set_duration(duration).set_position(("center", "bottom"))

            # Composite this segment
            segment_clip = CompositeVideoClip([visual_clip, txt_clip], size=(1920, 1080))
            segment_clip = segment_clip.set_audio(audio_clip)

            clips.append(segment_clip)

        if not clips:
             raise ValueError("Script resulted in no content.")

        final_clip = concatenate_videoclips(clips)
        output_filename = f"script_video_{os.urandom(4).hex()}.mp4"
        output_path = os.path.join(self.output_dir, output_filename)

        final_clip.write_videofile(output_path, fps=24, codec="libx264", audio_codec="aac")

        final_clip.close()
        return output_path
