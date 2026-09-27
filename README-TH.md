# ฟ้าไทย — ซอร์สโค้ดต้นฉบับ

ส่งออกจากโปรเจกต์ thai-weather-live เมื่อ 25 กันยายน 2026
Source commit: 7c061e1724b5e7beafa13b446534cbdad3dd5239

## โครงสร้าง
- dist/index.html — หน้าเว็บ
- dist/app.js — การทำงานของแผนที่ เรดาร์ และพยากรณ์
- dist/style.css — รูปแบบหน้าจอ
- dist/vendor/ — Leaflet ที่ใช้ในโปรเจกต์
- dist/favicon.svg — ไอคอนเว็บ
- .openai/hosting.json — การตั้งค่าโฮสต์ของโปรเจกต์เดิม

ไฟล์ต้นฉบับในโปรเจกต์นี้เป็น HTML, CSS และ JavaScript อยู่ใน dist โดยตรง
ไม่มีขั้นตอน build และไม่ต้องใช้ npm install
ไฟล์โปรเจกต์ทั้งหมดเก็บตามต้นฉบับ ไม่มีการแก้โค้ดเว็บในการส่งออกครั้งนี้

## รันบน Windows (ต้องมี Python 3)
1. แตก ZIP
2. เปิด Terminal ในโฟลเดอร์ thai-weather-live
3. รัน:

   py -m http.server 8000 --bind 127.0.0.1 --directory dist

4. เปิด http://localhost:8000
5. หยุดเซิร์ฟเวอร์ด้วย Ctrl+C

## รันบน macOS / Linux (ต้องมี Python 3)

   python3 -m http.server 8000 --bind 127.0.0.1 --directory dist

เปิด http://localhost:8000

## หมายเหตุ
- ให้รันผ่าน HTTP server เพราะเส้นทางไฟล์เริ่มจาก /; การดับเบิลคลิก index.html อาจโหลดไฟล์ไม่ครบ
- ต้องมีอินเทอร์เน็ตสำหรับ API อากาศ ภาพเรดาร์ แผนที่ และฟอนต์
- โค้ดที่ส่งออกเรียก Open-Meteo และ RainViewer โดยไม่มี API key ฝังไว้
- บริการภายนอกยังอยู่ภายใต้เงื่อนไขและข้อจำกัดของผู้ให้บริการแต่ละราย
- หากนำขึ้นโฮสต์อื่น ให้กำหนด document root เป็น dist
- การส่งออกนี้ไม่รวม Git history, ข้อมูลบัญชีเข้าสู่ระบบ หรือสิทธิ์การเข้าชมของโฮสต์เดิม
