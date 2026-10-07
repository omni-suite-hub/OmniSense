#!/usr/bin/env python3
"""
Generate complete set of store icons, promo tiles, and high-res store screenshots
for Chrome Web Store, Microsoft Edge Add-ons, and Mozilla Firefox AMO.
All typography is rendered using crisp native system fonts without missing glyphs.
"""

import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

DEST_DIR = "../assets_and_graphics"
ICONS_DIR = os.path.join(DEST_DIR, "icons")
PROMO_DIR = os.path.join(DEST_DIR, "promo_tiles")
SCREEN_DIR = os.path.join(DEST_DIR, "screenshots")

os.makedirs(ICONS_DIR, exist_ok=True)
os.makedirs(PROMO_DIR, exist_ok=True)
os.makedirs(SCREEN_DIR, exist_ok=True)

FONT_HEITI = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_HEITI_LIGHT = "/System/Library/Fonts/STHeiti Light.ttc"
FONT_SANS = "/System/Library/Fonts/Helvetica.ttc"

def wrap_text(text, font, max_width):
    lines = []
    cur = ''
    for ch in text:
        test = cur + ch
        w = font.getbbox(test)[2] - font.getbbox(test)[0]
        if w > max_width and cur:
            lines.append(cur)
            cur = ch
        else:
            cur = test
    if cur:
        lines.append(cur)
    return lines

def get_font(size, bold=True):
    try:
        path = FONT_HEITI if bold else FONT_HEITI_LIGHT
        return ImageFont.truetype(path, size)
    except:
        return ImageFont.load_default()

# ----------------- 1. Generate Icons -----------------
def generate_icons():
    logo_src = "brand/omnisense-logo-512.png"
    if not os.path.exists(logo_src):
        logo_src = "assets/icons/icon-128.png"
    base_img = Image.open(logo_src).convert("RGBA")
    
    sizes = [16, 32, 48, 64, 96, 128, 256, 300, 512]
    for s in sizes:
        resized = base_img.resize((s, s), Image.Resampling.LANCZOS)
        out_path = os.path.join(ICONS_DIR, f"icon-{s}.png")
        resized.save(out_path, "PNG")
        print(f"Generated icon: {out_path} ({s}x{s})")

# ----------------- Helper Drawing Functions -----------------
def draw_gradient(im, top_color, bottom_color):
    """Draw a smooth vertical gradient."""
    w, h = im.size
    dr = ImageDraw.Draw(im)
    r1, g1, b1 = top_color
    r2, g2, b2 = bottom_color
    for y in range(h):
        ratio = y / float(h)
        r = int(r1 + (r2 - r1) * ratio)
        g = int(g1 + (g2 - g1) * ratio)
        b = int(b1 + (b2 - b1) * ratio)
        dr.line([(0, y), (w, y)], fill=(r, g, b))

def add_ambient_glow(im, center, radius, color, alpha=40):
    """Add a soft radial neon glow."""
    glow = Image.new("RGBA", im.size, (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow)
    cx, cy = center
    steps = 15
    for i in range(steps, 0, -1):
        cur_r = int(radius * (i / steps))
        cur_a = int(alpha * (1.0 - (i / steps)))
        fill = (color[0], color[1], color[2], cur_a)
        gdraw.ellipse([cx - cur_r, cy - cur_r, cx + cur_r, cy + cur_r], fill=fill)
    glow = glow.filter(ImageFilter.GaussianBlur(radius // 3))
    im.alpha_composite(glow)

def draw_pill_badge(draw, xy, text, font, bg_color, text_color, border_color=None):
    """Draw a modern rounded pill badge."""
    x, y = xy
    bbox = font.getbbox(text)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    pad_h = 10
    pad_v = 4
    w = tw + pad_h * 2
    h = th + pad_v * 2
    draw.rounded_rectangle([x, y, x + w, y + h], radius=h // 2, fill=bg_color, outline=border_color, width=1)
    draw.text((x + pad_h, y + pad_v - bbox[1] // 2), text, font=font, fill=text_color)
    return w, h

# ----------------- 2. Promotional Banners -----------------
def generate_promo_small():
    """Chrome/Edge Small Tile: 440 x 280"""
    w, h = 440, 280
    im = Image.new("RGBA", (w, h), (11, 15, 25, 255))
    draw_gradient(im, (15, 23, 42), (9, 13, 22))
    
    # Ambient glows
    add_ambient_glow(im, (90, 140), 120, (16, 185, 129), 70)
    add_ambient_glow(im, (360, 60), 100, (139, 92, 246), 40)
    
    # Draw Logo
    logo = Image.open(os.path.join(ICONS_DIR, "icon-128.png")).convert("RGBA")
    logo = logo.resize((100, 100), Image.Resampling.LANCZOS)
    im.paste(logo, (35, 90), logo)
    
    draw = ImageDraw.Draw(im)
    
    # Title & Branding
    f_title = get_font(28, bold=True)
    f_sub = get_font(13, bold=False)
    f_badge = get_font(11, bold=True)
    
    draw.text((155, 78), "OmniSense", font=f_title, fill=(255, 255, 255))
    draw.text((155, 116), "本地 AI 智能伴读助手", font=f_sub, fill=(52, 211, 153))
    draw.text((155, 138), "100% 隐私零上传 · 端侧模型极速运行", font=get_font(11, bold=False), fill=(148, 163, 184))
    
    # Badges without emojis
    badges = ["专属早报", "观点天平", "音画同步", "套路雷达"]
    bx = 35
    by = 222
    for b in badges:
        bw, _ = draw_pill_badge(draw, (bx, by), b, f_badge, (24, 32, 48), (226, 232, 240), (51, 65, 85))
        bx += bw + 8

    # Border
    draw.rectangle([0, 0, w - 1, h - 1], outline=(51, 65, 85), width=1)
    
    out_path = os.path.join(PROMO_DIR, "promo_small_440x280.png")
    im.save(out_path, "PNG")
    print(f"Generated promo small: {out_path}")

def generate_promo_marquee():
    """Chrome/Edge Large Marquee Banner: 1400 x 560"""
    w, h = 1400, 560
    im = Image.new("RGBA", (w, h), (11, 15, 25, 255))
    draw_gradient(im, (14, 20, 36), (7, 10, 18))
    
    # Large ambient glow
    add_ambient_glow(im, (240, 280), 300, (16, 185, 129), 80)
    add_ambient_glow(im, (1150, 200), 350, (139, 92, 246), 60)
    add_ambient_glow(im, (700, 480), 250, (56, 189, 248), 40)
    
    draw = ImageDraw.Draw(im)
    
    # Left Content Area
    logo = Image.open(os.path.join(ICONS_DIR, "icon-256.png")).convert("RGBA")
    logo = logo.resize((150, 150), Image.Resampling.LANCZOS)
    im.paste(logo, (90, 85), logo)
    
    f_tag = get_font(15, bold=True)
    draw_pill_badge(draw, (265, 95), "LOCAL AI · ON-DEVICE INFERENCE", f_tag, (20, 36, 42), (52, 211, 153), (16, 185, 129))
    
    f_h1 = get_font(44, bold=True)
    draw.text((265, 132), "OmniSense 全知随行", font=f_h1, fill=(255, 255, 255))
    
    f_lead = get_font(20, bold=False)
    draw.text((265, 192), "浏览器里的第二大脑 · 数据全本地 · 体验零妥协", font=f_lead, fill=(148, 163, 184))
    
    # Feature Bullet Cards on Left
    f_b_title = get_font(17, bold=True)
    f_b_desc = get_font(13, bold=False)
    
    features = [
        ("今日专属早报电台", "48 小时浏览记忆深度重构，早晨一键听取新闻纪要"),
        ("观点天平与客观度量", "量化事实与主观情绪比重，智能提供逆向辩护视角"),
        ("听网页与常驻悬浮球", "离线高品质自然人声，平滑卡拉OK音画同步高亮跟随"),
        ("网页套路与霸王条款审查", "倒计时促单陷阱与隐蔽隐私条款一秒现形粉碎")
    ]
    
    start_y = 265
    for title, desc in features:
        # Draw small glowing dot
        draw.ellipse([95, start_y + 4, 105, start_y + 14], fill=(16, 185, 129, 255))
        draw.text((120, start_y), title, font=f_b_title, fill=(241, 245, 249))
        draw.text((120, start_y + 24), desc, font=f_b_desc, fill=(148, 163, 184))
        start_y += 65

    # Right Showcase: Simulated Modern SidePanel UI Mockup
    card_x, card_y, card_w, card_h = 790, 60, 520, 440
    # Card shadow
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle([card_x - 10, card_y + 10, card_x + card_w + 10, card_y + card_h + 20], radius=24, fill=(0, 0, 0, 140))
    shadow = shadow.filter(ImageFilter.GaussianBlur(20))
    im.alpha_composite(shadow)
    
    draw = ImageDraw.Draw(im)
    draw.rounded_rectangle([card_x, card_y, card_x + card_w, card_y + card_h], radius=16, fill=(17, 24, 39, 235), outline=(255, 255, 255, 45), width=1)
    
    # Card Header
    draw.ellipse([card_x + 18, card_y + 18, card_x + 28, card_y + 28], fill=(239, 68, 68))
    draw.ellipse([card_x + 36, card_y + 18, card_x + 46, card_y + 28], fill=(245, 158, 11))
    draw.ellipse([card_x + 54, card_y + 18, card_x + 64, card_y + 28], fill=(16, 185, 129))
    draw.text((card_x + 80, card_y + 15), "OmniSense 智能伴读控制台", font=get_font(13, bold=True), fill=(148, 163, 184))
    
    # Inside Mockup Content: Radio Card & Bias Meter
    inner_x = card_x + 20
    # Subcard 1: Radio
    draw.rounded_rectangle([inner_x, card_y + 50, inner_x + card_w - 40, card_y + 185], radius=12, fill=(15, 23, 42, 255), outline=(16, 185, 129))
    draw.text((inner_x + 16, card_y + 65), "今日早报电台 · 晨间播报", font=get_font(15, bold=True), fill=(52, 211, 153))
    draw.text((inner_x + 16, card_y + 90), "“早上好！已为您汇编昨日浏览的 14 篇科技与宏观经济资讯…”", font=get_font(12, bold=False), fill=(226, 232, 240))
    
    # Waveform bars
    wx = inner_x + 16
    bar_heights = [12, 24, 18, 32, 28, 40, 22, 36, 16, 28, 34, 18, 26, 38, 20, 10]
    for bh in bar_heights:
        draw.rounded_rectangle([wx, card_y + 155 - bh, wx + 6, card_y + 155], radius=3, fill=(16, 185, 129, 220))
        wx += 12
    draw.text((inner_x + 230, card_y + 130), "▶ 正在播报 (1.0x)", font=get_font(12, bold=True), fill=(52, 211, 153))

    # Subcard 2: Bias Meter
    draw.rounded_rectangle([inner_x, card_y + 205, inner_x + card_w - 40, card_y + 415], radius=12, fill=(15, 23, 42, 255), outline=(51, 65, 85))
    draw.text((inner_x + 16, card_y + 220), "观点客观度天平与立场剖析", font=get_font(15, bold=True), fill=(241, 245, 249))
    
    # Bars
    draw.text((inner_x + 16, card_y + 248), "客观事实度 [64%]", font=get_font(12, bold=True), fill=(52, 211, 153))
    draw.rounded_rectangle([inner_x + 16, card_y + 268, inner_x + 460, card_y + 276], radius=4, fill=(30, 41, 59))
    draw.rounded_rectangle([inner_x + 16, card_y + 268, inner_x + int(444 * 0.64), card_y + 276], radius=4, fill=(16, 185, 129))
    
    draw.text((inner_x + 16, card_y + 290), "情绪主观度 [36%]", font=get_font(12, bold=True), fill=(245, 158, 11))
    draw.rounded_rectangle([inner_x + 16, card_y + 310, inner_x + 460, card_y + 318], radius=4, fill=(30, 41, 59))
    draw.rounded_rectangle([inner_x + 16, card_y + 310, inner_x + int(444 * 0.36), card_y + 318], radius=4, fill=(245, 158, 11))

    draw_pill_badge(draw, (inner_x + 16, card_y + 335), "【天平倾向：温和中立 / 事实论据充分】", get_font(12, bold=True), (20, 36, 42), (52, 211, 153), (16, 185, 129))
    draw.text((inner_x + 16, card_y + 372), "• 关键论证引用了权威行业出货数据与机构年报", font=get_font(11, bold=False), fill=(148, 163, 184))
    draw.text((inner_x + 16, card_y + 390), "• 末尾结论存在轻度商业前景推测，情绪较克制", font=get_font(11, bold=False), fill=(148, 163, 184))

    out_path = os.path.join(PROMO_DIR, "promo_marquee_1400x560.png")
    im.save(out_path, "PNG")
    print(f"Generated promo marquee: {out_path}")

def generate_promo_large():
    """920 x 680 Featured Banner"""
    w, h = 920, 680
    im = Image.new("RGBA", (w, h), (11, 15, 25, 255))
    draw_gradient(im, (15, 23, 42), (7, 10, 18))
    add_ambient_glow(im, (460, 200), 280, (16, 185, 129), 60)
    add_ambient_glow(im, (750, 450), 200, (139, 92, 246), 40)
    
    draw = ImageDraw.Draw(im)
    logo = Image.open(os.path.join(ICONS_DIR, "icon-128.png")).convert("RGBA")
    logo = logo.resize((120, 120), Image.Resampling.LANCZOS)
    im.paste(logo, (w // 2 - 60, 60), logo)
    
    f_h1 = get_font(34, bold=True)
    title = "OmniSense 全知随行"
    tw = f_h1.getbbox(title)[2] - f_h1.getbbox(title)[0]
    draw.text(((w - tw) // 2, 200), title, font=f_h1, fill=(255, 255, 255))
    
    f_sub = get_font(18, bold=False)
    sub = "本地端侧 AI 浏览器超级伴读 · 100% 隐私零泄露"
    sw = f_sub.getbbox(sub)[2] - f_sub.getbbox(sub)[0]
    draw.text(((w - sw) // 2, 246), sub, font=f_sub, fill=(52, 211, 153))
    
    cards = [
        ("今日专属早报", "汇总 48h 浏览记忆，智能生成口语化电台晨报"),
        ("观点客观度天平", "量化事实与主观情绪，智能拆解多维论据"),
        ("智能常驻悬浮球", "无缝离线发音，网页平滑高亮伴读跟随"),
        ("网页防套路雷达", "虚假促单倒计时与霸王条款一秒粉碎")
    ]
    
    cx_list = [70, 480, 70, 480]
    cy_list = [310, 310, 480, 480]
    
    for i, (title, desc) in enumerate(cards):
        cx, cy = cx_list[i], cy_list[i]
        draw.rounded_rectangle([cx, cy, cx + 370, cy + 140], radius=14, fill=(17, 24, 39, 200), outline=(24, 32, 48), width=1)
        draw.text((cx + 20, cy + 24), title, font=get_font(18, bold=True), fill=(241, 245, 249))
        draw.text((cx + 20, cy + 62), desc, font=get_font(13, bold=False), fill=(148, 163, 184))
        draw_pill_badge(draw, (cx + 20, cy + 96), "100% 本地运算", get_font(11, bold=True), (20, 36, 42), (52, 211, 153))

    out_path = os.path.join(PROMO_DIR, "promo_large_920x680.png")
    im.save(out_path, "PNG")
    print(f"Generated promo large: {out_path}")

# ----------------- 3. High-Res Store Screenshots (1280x800) -----------------
def create_base_screenshot_frame(headline, subtitle, category_tag="OMNISENSE LOCAL AI"):
    """Create a standardized high-end 1280x800 showcase template."""
    w, h = 1280, 800
    im = Image.new("RGBA", (w, h), (11, 15, 25, 255))
    draw_gradient(im, (15, 23, 42), (8, 12, 20))
    
    # Ambient glows
    add_ambient_glow(im, (200, 180), 220, (16, 185, 129), 55)
    add_ambient_glow(im, (1100, 220), 250, (139, 92, 246), 45)
    
    draw = ImageDraw.Draw(im)
    
    # Category Tag
    draw_pill_badge(draw, (60, 36), category_tag, get_font(11, bold=True), (20, 36, 42), (52, 211, 153), (16, 185, 129))
    
    # Headline & Subtitle
    draw.text((60, 68), headline, font=get_font(28, bold=True), fill=(255, 255, 255))
    draw.text((60, 108), subtitle, font=get_font(15, bold=False), fill=(148, 163, 184))
    
    # Main Window Frame
    win_x, win_y, win_w, win_h = 60, 150, 1160, 600
    # Drop shadow
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow)
    sdraw.rounded_rectangle([win_x - 12, win_y + 12, win_x + win_w + 12, win_y + win_h + 24], radius=24, fill=(0, 0, 0, 160))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    im.alpha_composite(shadow)
    
    # Re-draw window
    draw = ImageDraw.Draw(im)
    draw.rounded_rectangle([win_x, win_y, win_x + win_w, win_y + win_h], radius=16, fill=(15, 23, 42, 245), outline=(255, 255, 255, 40), width=1)
    
    # Window Titlebar
    draw.ellipse([win_x + 20, win_y + 18, win_x + 30, win_y + 28], fill=(239, 68, 68))
    draw.ellipse([win_x + 38, win_y + 18, win_x + 48, win_y + 28], fill=(245, 158, 11))
    draw.ellipse([win_x + 56, win_y + 18, win_x + 66, win_y + 28], fill=(16, 185, 129))
    draw.text((win_x + 85, win_y + 15), "OmniSense 智能浏览器伴读控制中心", font=get_font(13, bold=True), fill=(148, 163, 184))
    
    # Status dot on titlebar right
    draw.ellipse([win_x + win_w - 140, win_y + 18, win_x + win_w - 132, win_y + 26], fill=(16, 185, 129))
    draw.text((win_x + win_w - 124, win_y + 15), "本地模型就绪", font=get_font(12, bold=True), fill=(52, 211, 153))
    
    # Titlebar separator
    draw.line([(win_x, win_y + 44), (win_x + win_w, win_y + 44)], fill=(24, 32, 48), width=1)
    
    return im, draw, (win_x, win_y + 45, win_w, win_h - 45)

def generate_screenshot_1():
    """01: 今日早报电台"""
    im, draw, (x, y, w, h) = create_base_screenshot_frame(
        "今日早报电台 · 48小时记忆深度重构",
        "智能提取多标签页与历史浏览记录，一键生成专属早报串联稿与口语化广播播音"
    )
    
    card_x = x + 30
    card_y = y + 24
    card_w = w - 60
    
    draw.rounded_rectangle([card_x, card_y, card_x + card_w, card_y + 230], radius=16, fill=(20, 27, 45), outline=(16, 185, 129, 65))
    
    # Header inside card
    draw.text((card_x + 30, card_y + 26), "OmniSense 专属早报电台 (FM 88.6)", font=get_font(22, bold=True), fill=(52, 211, 153))
    draw_pill_badge(draw, (card_x + card_w - 230, card_y + 24), "2026年9月30日 · 晨间播送", get_font(12, bold=True), (24, 32, 48), (226, 232, 240))
    draw_pill_badge(draw, (card_x + card_w - 380, card_y + 24), "已汇编 18 篇网页", get_font(12, bold=True), (20, 36, 42), (52, 211, 153))
    
    # Player Controls Row
    draw.rounded_rectangle([card_x + 30, card_y + 75, card_x + 220, card_y + 120], radius=22, fill=(16, 185, 129), outline=(255, 255, 255, 50))
    draw.text((card_x + 55, card_y + 88), "▶ 正在播放早报", font=get_font(16, bold=True), fill=(255, 255, 255))
    
    # Soundwave visualizer
    wx = card_x + 250
    waves = [10, 26, 18, 38, 30, 48, 22, 42, 18, 34, 40, 25, 36, 45, 20, 32, 28, 14, 22, 38, 18, 10]
    for bh in waves:
        draw.rounded_rectangle([wx, card_y + 120 - bh, wx + 8, card_y + 120], radius=4, fill=(16, 185, 129, 220))
        wx += 16
        
    draw.text((card_x + card_w - 180, card_y + 90), "01:25 / 03:40  (1.0x)", font=get_font(15, bold=True), fill=(148, 163, 184))
    
    # Radio Progress Bar
    draw.rounded_rectangle([card_x + 30, card_y + 140, card_x + card_w - 30, card_y + 146], radius=3, fill=(51, 65, 85))
    draw.rounded_rectangle([card_x + 30, card_y + 140, card_x + int((card_w - 60) * 0.38), card_y + 146], radius=3, fill=(16, 185, 129))
    
    draw.text((card_x + 30, card_y + 175), "提示：无 Markdown 机械符号噪音、真人主持人语气串联、侧边栏关闭依然流畅播放", font=get_font(13, bold=False), fill=(148, 163, 184))
    
    # Script Box Preview
    script_y = card_y + 250
    draw.rounded_rectangle([card_x, script_y, card_x + card_w, y + h - 25], radius=16, fill=(13, 17, 28), outline=(24, 32, 48))
    
    draw_pill_badge(draw, (card_x + 25, script_y + 20), "早报实时串联文稿 (自动 Markdown 识别)", get_font(13, bold=True), (20, 36, 42), (52, 211, 153))
    
    lines = [
        ("【时事与科技观察】", True, (52, 211, 153)),
        ("各位听众早安！这里是您的 OmniSense 今日专属晨报电台。为您梳理过去 48 小时内的重点阅读：", False, (226, 232, 240)),
        ("• 前沿架构：关于 WebAssembly 与 WebGPU 端侧推理的实测表现，三大主流浏览器性能提升达 45%。", False, (203, 213, 225)),
        ("• 宏观视野：全球半导体产业重构趋势中，资本支出逐步收窄，供应链趋于更加均衡和本土化。", False, (203, 213, 225)),
        ("• 个人心智：在信息繁杂的时代，建立专属的星图认知连接比被动接受算法推荐更具复利价值。", False, (203, 213, 225)),
        ("【今日灵感寄语】", True, (52, 211, 153)),
        ("“保持思考的自主性，每一篇你认真读过的好文章，都是认知大厦的一块坚固砖石。”", False, (148, 163, 184))
    ]
    
    ly = script_y + 58
    for text, is_header, col in lines:
        f = get_font(15 if is_header else 13, bold=is_header)
        draw.text((card_x + 25, ly), text, font=f, fill=col)
        ly += 26
        
    out_path = os.path.join(SCREEN_DIR, "01_screen_daily_briefing_1280x800.png")
    im.save(out_path, "PNG")
    print(f"Generated screenshot 1: {out_path}")

def generate_screenshot_2():
    """02: 客观度天平与立场剖析"""
    im, draw, (x, y, w, h) = create_base_screenshot_frame(
        "观点客观度天平与立场剖析 · 破解信息茧房",
        "深度量化文本事实依据比重与情绪煽动倾向，提供多维正反对抗视角与立场辩护"
    )
    
    col1_w = 460
    c1_x = x + 30
    c1_y = y + 25
    
    draw.rounded_rectangle([c1_x, c1_y, c1_x + col1_w, y + h - 25], radius=16, fill=(18, 24, 39), outline=(51, 65, 85))
    draw.text((c1_x + 24, c1_y + 24), "立场客观度天平", font=get_font(20, bold=True), fill=(241, 245, 249))
    
    # Fact Gauge
    draw.text((c1_x + 24, c1_y + 70), "客观事实度 [64%]", font=get_font(15, bold=True), fill=(52, 211, 153))
    draw.rounded_rectangle([c1_x + 24, c1_y + 98, c1_x + col1_w - 24, c1_y + 110], radius=6, fill=(30, 41, 59))
    draw.rounded_rectangle([c1_x + 24, c1_y + 98, c1_x + int((col1_w - 48) * 0.64), c1_y + 110], radius=6, fill=(16, 185, 129))
    draw.text((c1_x + 24, c1_y + 120), "包含翔实的公开数据、时间戳与第三方机构财报引用", font=get_font(11, bold=False), fill=(148, 163, 184))
    
    # Emotion Gauge
    draw.text((c1_x + 24, c1_y + 155), "情绪主观度 [36%]", font=get_font(15, bold=True), fill=(245, 158, 11))
    draw.rounded_rectangle([c1_x + 24, c1_y + 183, c1_x + col1_w - 24, c1_y + 195], radius=6, fill=(30, 41, 59))
    draw.rounded_rectangle([c1_x + 24, c1_y + 183, c1_x + int((col1_w - 48) * 0.36), c1_y + 195], radius=6, fill=(245, 158, 11))
    draw.text((c1_x + 24, c1_y + 205), "存在部分排他性修辞与对未来竞争对手的预判性陈述", font=get_font(11, bold=False), fill=(148, 163, 184))

    # Balance Badge
    draw_pill_badge(draw, (c1_x + 24, c1_y + 245), "综合评估：温和中立 · 论据较为扎实", get_font(14, bold=True), (20, 36, 42), (52, 211, 153), (16, 185, 129))
    
    attrs = [
        ("事实可靠度", "四星半  (权威数据支撑)"),
        ("逻辑完整性", "四星  (结构较为严密)"),
        ("商业利益倾向", "中度关联 (含行业推广视角)"),
        ("对立观点包容度", "低 (未提及相反技术路径)")
    ]
    ay = c1_y + 300
    for label, val in attrs:
        draw.text((c1_x + 24, ay), label, font=get_font(13, bold=True), fill=(226, 232, 240))
        draw.text((c1_x + 160, ay), val, font=get_font(13, bold=False), fill=(52, 211, 153))
        ay += 32

    # Right Column: AI Analysis Result
    c2_x = c1_x + col1_w + 24
    c2_w = w - col1_w - 84
    draw.rounded_rectangle([c2_x, c1_y, c2_x + c2_w, y + h - 25], radius=16, fill=(13, 17, 28), outline=(24, 32, 48))
    
    draw_pill_badge(draw, (c2_x + 24, c1_y + 20), "【立场剖析与深度拆解】", get_font(13, bold=True), (20, 36, 42), (52, 211, 153))
    
    analysis_lines = [
        ("• 核心论据与支撑事实：", True, (241, 245, 249)),
        ("  作者列举了过去三年晶圆厂建厂周期与资本支出数据，真实度极高，符合行业公认基准。", False, (203, 213, 225)),
        ("• 隐蔽假设与思维盲区：", True, (241, 245, 249)),
        ("  文章默认先进封装能完全弥补制程差距，忽视了热功耗与封装良率对成本的边际影响。", False, (203, 213, 225)),
        ("• 正反对抗辩护观点 (破茧视角)：", True, (56, 189, 248)),
        ("  若从全球分工视角反驳：单一区域自建全产业链可能导致全球研发效率被摊薄，成本激增40%以上。", False, (203, 213, 225)),
        ("• 推荐延伸思考：", True, (245, 158, 11)),
        ("  可结合开源 RISC-V 生态的发展现状，交叉验证芯片自主化的中长期商业落地速度。", False, (148, 163, 184))
    ]
    
    ay = c1_y + 60
    for text, is_header, col in analysis_lines:
        f = get_font(14 if is_header else 12, bold=is_header)
        draw.text((c2_x + 24, ay), text, font=f, fill=col)
        ay += 28

    out_path = os.path.join(SCREEN_DIR, "02_screen_bias_meter_1280x800.png")
    im.save(out_path, "PNG")
    print(f"Generated screenshot 2: {out_path}")

def generate_screenshot_3():
    """03: 时光胶囊与星图知识网络"""
    im, draw, (x, y, w, h) = create_base_screenshot_frame(
        "时光胶囊与星图知识网络 · 唤醒认知连接",
        "交互式力导向拓扑星图，智能聚类过往阅读痕迹，跨文章自动发现潜在语义关联"
    )
    
    canvas_x = x + 30
    canvas_y = y + 25
    canvas_w = w - 60
    canvas_h = h - 50
    
    draw.rounded_rectangle([canvas_x, canvas_y, canvas_x + canvas_w, canvas_y + canvas_h], radius=16, fill=(10, 14, 26), outline=(51, 65, 85))
    
    # Top Controls on Canvas
    draw_pill_badge(draw, (canvas_x + 24, canvas_y + 20), "知识拓扑星图", get_font(13, bold=True), (20, 36, 42), (52, 211, 153), (16, 185, 129))
    draw_pill_badge(draw, (canvas_x + 150, canvas_y + 20), "42 个收录网页", get_font(12, bold=False), (24, 32, 48), (226, 232, 240))
    draw_pill_badge(draw, (canvas_x + 280, canvas_y + 20), "86 条高相关度语义连接", get_font(12, bold=False), (24, 32, 48), (226, 232, 240))
    
    # Search box in canvas
    draw.rounded_rectangle([canvas_x + canvas_w - 300, canvas_y + 18, canvas_x + canvas_w - 24, canvas_y + 50], radius=16, fill=(20, 27, 45), outline=(255, 255, 255, 40))
    draw.text((canvas_x + canvas_w - 280, canvas_y + 26), "检索：搜索知识星图节点…", font=get_font(12, bold=False), fill=(148, 163, 184))

    # Draw Nodes and Links
    nodes = [
        ("OmniSense Core", (580, 450), 32, (16, 185, 129)),
        ("端侧 AI 推理", (420, 360), 24, (52, 211, 153)),
        ("WebAssembly WASM", (280, 450), 22, (52, 211, 153)),
        ("WebGPU 渲染加速", (350, 290), 20, (52, 211, 153)),
        ("信息天平算法", (760, 350), 24, (139, 92, 246)),
        ("认知反脆弱", (910, 300), 20, (139, 92, 246)),
        ("半导体产业链", (800, 500), 22, (245, 158, 11)),
        ("芯片制程演进", (950, 460), 18, (245, 158, 11)),
        ("语音合成 TTS", (440, 550), 22, (56, 189, 248)),
        ("音画同步高亮", (290, 570), 18, (56, 189, 248)),
        ("极简禅阅读", (670, 550), 20, (236, 72, 153)),
        ("暗黑无干扰", (820, 580), 18, (236, 72, 153))
    ]
    
    links = [
        (0, 1), (0, 4), (0, 6), (0, 8), (0, 10),
        (1, 2), (1, 3), (2, 3),
        (4, 5), (6, 7), (8, 9), (10, 11)
    ]
    
    for u, v in links:
        p1 = nodes[u][1]
        p2 = nodes[v][1]
        draw.line([p1, p2], fill=(255, 255, 255, 45), width=2)
        
    for name, (nx, ny), r, col in nodes:
        draw.ellipse([nx - r - 6, ny - r - 6, nx + r + 6, ny + r + 6], fill=(col[0], col[1], col[2], 50))
        draw.ellipse([nx - r, ny - r, nx + r, ny + r], fill=col)
        bbox = get_font(12, bold=True).getbbox(name)
        nw = bbox[2] - bbox[0]
        draw.text((nx - nw // 2, ny + r + 8), name, font=get_font(12, bold=True), fill=(241, 245, 249))

    # Hover Card on Node 1
    hx, hy = 460, 260
    draw.rounded_rectangle([hx, hy, hx + 280, hy + 130], radius=12, fill=(15, 23, 42, 245), outline=(16, 185, 129, 120), width=1)
    draw_pill_badge(draw, (hx + 14, hy + 12), "关联网页节点", get_font(11, bold=True), (20, 36, 42), (52, 211, 153))
    draw.text((hx + 14, hy + 40), "《WebGPU 与端侧大模型演进实测》", font=get_font(13, bold=True), fill=(255, 255, 255))
    draw.text((hx + 14, hy + 66), "余弦相似匹配度: 89% · 关联度极高", font=get_font(11, bold=False), fill=(52, 211, 153))
    draw.text((hx + 14, hy + 90), "点击可一键查看相关段落或发起交叉提问", font=get_font(11, bold=False), fill=(148, 163, 184))

    out_path = os.path.join(SCREEN_DIR, "03_screen_knowledge_graph_1280x800.png")
    im.save(out_path, "PNG")
    print(f"Generated screenshot 3: {out_path}")

def generate_screenshot_4():
    """04: 智能常驻悬浮球与卡拉OK伴读"""
    im, draw, (x, y, w, h) = create_base_screenshot_frame(
        "智能常驻悬浮球与卡拉OK伴读 · 听见网页",
        "侧边栏关闭依然在后台平滑朗读，全文字词级卡拉OK音画同步高亮，支持动态无感调速"
    )
    
    web_x = x + 30
    web_y = y + 25
    web_w = w - 60
    web_h = h - 50
    
    draw.rounded_rectangle([web_x, web_y, web_x + web_w, web_y + web_h], radius=16, fill=(13, 17, 28), outline=(51, 65, 85))
    
    # Web content
    draw.text((web_x + 50, web_y + 35), "科技深度观察 · 人工智能与隐私架构", font=get_font(13, bold=True), fill=(52, 211, 153))
    draw.text((web_x + 50, web_y + 65), "为什么未来的 AI 是属于端侧本地的时代？", font=get_font(26, bold=True), fill=(255, 255, 255))
    draw.text((web_x + 50, web_y + 110), "作者：OmniSense 研选团队 · 发布于 2026年9月 · 阅读时间约 6 分钟", font=get_font(12, bold=False), fill=(148, 163, 184))
    draw.line([(web_x + 50, web_y + 140), (web_x + web_w - 50, web_y + 140)], fill=(24, 32, 48))
    
    # Paragraph 1
    p1 = "随着大模型参数压缩技术和端侧芯片 NPU 的爆发式普及，传统的云端集中式推理正在面临高昂算力成本与数据隐私合规的双重挑战。"
    for line in wrap_text(p1, get_font(14, bold=False), 680):
        draw.text((web_x + 50, web_y + 165), line, font=get_font(14, bold=False), fill=(203, 213, 225))
    
    # Paragraph 2 - ACTIVE KARAOKE HIGHLIGHT
    draw.rounded_rectangle([web_x + 46, web_y + 205, web_x + 740, web_y + 270], radius=8, fill=(20, 36, 42), outline=(16, 185, 129, 100), width=1)
    p2 = "“本地端侧 AI 的真正魅力在于：你的每一个思考瞬间与浏览记录，都永远只留在你自己的设备中。”"
    p2_lines = wrap_text(p2, get_font(15, bold=True), 660)
    p2y = web_y + 215
    for line in p2_lines:
        draw.text((web_x + 56, p2y), line, font=get_font(15, bold=True), fill=(52, 211, 153))
        p2y += 24
    
    # Paragraph 3
    p3 = "无论是日常文章速读、长篇协议审查还是个人私密写作，将算力收拢到个人设备，不仅带来毫秒级的极速首字反馈，更从根本上消除了隐私被第三方窥探或用作训练集的顾虑。"
    p3_lines = wrap_text(p3, get_font(14, bold=False), 680)
    p3y = web_y + 288
    for line in p3_lines:
        draw.text((web_x + 50, p3y), line, font=get_font(14, bold=False), fill=(203, 213, 225))
        p3y += 22
    
    # Paragraph 4
    p4 = "这也是 OmniSense 始终坚持全栈纯本地化部署的初心所在——把数字世界的主动权，完整交还给每一位使用者。"
    p4_lines = wrap_text(p4, get_font(14, bold=False), 680)
    p4y = p3y + 12
    for line in p4_lines:
        draw.text((web_x + 50, p4y), line, font=get_font(14, bold=False), fill=(148, 163, 184))
        p4y += 22

    # Floating Ball Callout & Showcase
    ball_x = web_x + web_w - 340
    ball_y = web_y + 220
    
    draw.rounded_rectangle([ball_x, ball_y, ball_x + 300, ball_y + 280], radius=20, fill=(18, 25, 42, 245), outline=(16, 185, 129, 140), width=2)
    
    # Pulse soundwave around ball
    add_ambient_glow(im, (ball_x + 150, ball_y + 80), 60, (16, 185, 129), 80)
    draw.ellipse([ball_x + 110, ball_y + 40, ball_x + 190, ball_y + 120], fill=(16, 185, 129, 220), outline=(255, 255, 255, 120), width=2)
    draw.text((ball_x + 138, ball_y + 68), "||", font=get_font(20, bold=True), fill=(255, 255, 255))
    
    draw.text((ball_x + 85, ball_y + 135), "听网页 · 动态悬浮球", font=get_font(16, bold=True), fill=(255, 255, 255))
    draw_pill_badge(draw, (ball_x + 80, ball_y + 165), "正在播读 第 2 / 6 段", get_font(11, bold=True), (20, 36, 42), (52, 211, 153))
    
    # Mini controls
    draw_pill_badge(draw, (ball_x + 35, ball_y + 205), "< 上一句", get_font(12, bold=False), (24, 32, 48), (226, 232, 240))
    draw_pill_badge(draw, (ball_x + 125, ball_y + 205), "1.25x 调速", get_font(12, bold=True), (20, 36, 42), (52, 211, 153))
    draw_pill_badge(draw, (ball_x + 215, ball_y + 205), "下一句 >", get_font(12, bold=False), (24, 32, 48), (226, 232, 240))

    draw.text((ball_x + 25, ball_y + 248), "● 侧边栏关闭后悬浮球依然常驻播音", font=get_font(11, bold=False), fill=(52, 211, 153))

    out_path = os.path.join(SCREEN_DIR, "04_screen_smart_floating_ball_1280x800.png")
    im.save(out_path, "PNG")
    print(f"Generated screenshot 4: {out_path}")

def generate_screenshot_5():
    """05: 极简禅阅读与防套路雷达"""
    im, draw, (x, y, w, h) = create_base_screenshot_frame(
        "极简禅阅读与防套路雷达 · 纯净安全浏览",
        "智能剔除网页浮动广告与干扰杂质，一键粉碎心理催单假倒计时，严厉审查霸王隐私条款"
    )
    
    split_w = (w - 70) // 2
    
    # Left: Zen Reader
    left_x = x + 25
    top_y = y + 25
    draw.rounded_rectangle([left_x, top_y, left_x + split_w, y + h - 25], radius=16, fill=(18, 22, 30), outline=(51, 65, 85))
    
    draw_pill_badge(draw, (left_x + 24, top_y + 20), "极简禅阅读模式", get_font(13, bold=True), (20, 36, 42), (52, 211, 153))
    draw_pill_badge(draw, (left_x + 160, top_y + 20), "雅灰暗黑主题", get_font(11, bold=False), (24, 32, 48), (203, 213, 225))
    draw.text((left_x + split_w - 140, top_y + 24), "预估阅读 4 分钟", font=get_font(12, bold=False), fill=(148, 163, 184))
    
    draw.text((left_x + 24, top_y + 65), "《从零构建高性能浏览器扩展架构》", font=get_font(18, bold=True), fill=(255, 255, 255))
    
    zen_p = [
        "现代网页往往充斥着横幅广告、侧边弹窗与强制滚动的推荐模块，严重割裂了深度阅读时的心流体验。",
        "禅阅读模式智能提取正文核心 DOM 骨架，屏蔽所有浮动追踪脚本与花哨动效，呈现出纯净的书卷质感。",
        "配合侧边智能边注功能，随时为你提炼段落关键论点，无需打断视线节奏。"
    ]
    zy = top_y + 105
    for zp in zen_p:
        lines = wrap_text(zp, get_font(13, bold=False), split_w - 50)
        for line in lines:
            draw.text((left_x + 24, zy), line, font=get_font(13, bold=False), fill=(203, 213, 225))
            zy += 20
        zy += 10
        
    # Side Margin Note in Zen Reader
    draw.rounded_rectangle([left_x + 24, zy + 15, left_x + split_w - 24, zy + 120], radius=10, fill=(26, 33, 48), outline=(16, 185, 129))
    draw_pill_badge(draw, (left_x + 36, zy + 25), "AI 智能侧注", get_font(11, bold=True), (20, 36, 42), (52, 211, 153))
    draw.text((left_x + 36, zy + 54), "段落核心：通过消除网页视觉噪点，深度阅读理解效率可提升 35% 以上。", font=get_font(12, bold=False), fill=(226, 232, 240))
    draw.text((left_x + 36, zy + 78), "适用场景：学术论文、财经研报、深度长文阅读", font=get_font(11, bold=False), fill=(148, 163, 184))

    # Right: Pattern Radar & Privacy Agreement
    right_x = left_x + split_w + 20
    draw.rounded_rectangle([right_x, top_y, right_x + split_w, y + h - 25], radius=16, fill=(15, 20, 32), outline=(51, 65, 85))
    
    draw_pill_badge(draw, (right_x + 24, top_y + 20), "套路雷达 & 协议审查", get_font(13, bold=True), (45, 22, 28), (248, 113, 113), (239, 68, 68))
    
    # Feature 1: Fake countdown
    draw.rounded_rectangle([right_x + 24, top_y + 65, right_x + split_w - 24, top_y + 155], radius=12, fill=(24, 18, 25), outline=(239, 68, 68))
    draw.text((right_x + 38, top_y + 78), "警告：识别到虚假心理促单倒计时！", font=get_font(15, bold=True), fill=(248, 113, 113))
    draw.text((right_x + 38, top_y + 104), "“仅剩 04:59 结束特惠” —— 经雷达检测，刷新页面该计时器自动重置！", font=get_font(12, bold=False), fill=(226, 232, 240))
    draw_pill_badge(draw, (right_x + 38, top_y + 126), "已识破心理促单套路", get_font(11, bold=True), (45, 22, 28), (248, 113, 113))

    # Feature 2: Cookie & Overlay auto-crush
    draw.rounded_rectangle([right_x + 24, top_y + 175, right_x + split_w - 24, top_y + 250], radius=12, fill=(18, 28, 35), outline=(16, 185, 129))
    draw.text((right_x + 38, top_y + 188), "● Cookie 追踪遮罩粉碎成功", font=get_font(15, bold=True), fill=(52, 211, 153))
    draw.text((right_x + 38, top_y + 214), "已自动拒绝全部非必要广告营销追踪，无弹窗阻挡阅读", font=get_font(12, bold=False), fill=(148, 163, 184))

    # Feature 3: Agreement inspection
    draw.rounded_rectangle([right_x + 24, top_y + 270, right_x + split_w - 24, y + h - 40], radius=12, fill=(20, 26, 40), outline=(245, 158, 11))
    draw.text((right_x + 38, top_y + 285), "用户服务协议与隐私审查", font=get_font(15, bold=True), fill=(245, 158, 11))
    draw_pill_badge(draw, (right_x + split_w - 180, top_y + 283), "风险评估：中度风险", get_font(11, bold=True), (45, 35, 20), (251, 191, 36))
    
    draw.text((right_x + 38, top_y + 315), "• 发现单方免责条款：“平台有权随时不经通知终止或变更服务内容”", font=get_font(12, bold=False), fill=(203, 213, 225))
    draw.text((right_x + 38, top_y + 342), "• 发现数据共享条款：“个人使用偏好可能共享给第三方商业化合作伙伴”", font=get_font(12, bold=False), fill=(203, 213, 225))
    draw.text((right_x + 38, top_y + 372), "• 建议：谨慎勾选默认授权同意项，避免授予全量数据读取权限", font=get_font(12, bold=True), fill=(52, 211, 153))

    out_path = os.path.join(SCREEN_DIR, "05_screen_zen_reader_radar_1280x800.png")
    im.save(out_path, "PNG")
    print(f"Generated screenshot 5: {out_path}")

def main():
    print("=== Generating Store Assets & Graphics (Refined) ===")
    generate_icons()
    generate_promo_small()
    generate_promo_marquee()
    generate_promo_large()
    generate_screenshot_1()
    generate_screenshot_2()
    generate_screenshot_3()
    generate_screenshot_4()
    generate_screenshot_5()
    print("=== All Store Assets & Graphics Successfully Generated! ===")

if __name__ == "__main__":
    main()
