# EduBot Công Dân Số (TT 02/2025)

Ứng dụng trò chơi học tập & đánh giá **24 năng lực Công dân số** dành cho lớp học dùng chung 10 máy tính bảng, tách riêng **Cổng Học sinh** và **Cổng Giáo viên** (mã PIN mặc định: `2025`).

## 1. Đẩy lên GitHub từ AI Studio & bật GitHub Pages (Không cần quyền Workflows)

Dự án đã build sẵn bản chạy tĩnh tối ưu cho GitHub Pages ngay trong thư mục **`docs/`** (và **không** chứa file `.github/workflows/` để nút **Push to GitHub** của AI Studio đẩy lên thành công ngay lập tức).

### Bước 1: Đẩy mã nguồn lên GitHub
- Bấm nút **Push to GitHub** ngay trên AI Studio (hoặc đẩy bằng Git lên nhánh `main`).
- Chọn chế độ **Public** cho repository để dùng GitHub Pages miễn phí.

### Bước 2: Bật GitHub Pages (1 cú click — không cần GitHub Actions)
1. Mở repository trên GitHub → chọn tab **Settings** → mục **Pages** (cột bên trái).
2. Ở phần **Build and deployment → Source**, giữ nguyên **Deploy from a branch**.
3. Chọn Branch: **`main`**, Folder: **`/docs`** → bấm **Save**.
4. Chờ khoảng 30–60 giây và tải lại trang **Settings → Pages** để lấy đường dẫn web:
   - **Cổng Học sinh (cho 10 máy tính bảng, KHÔNG cần đăng nhập):**
     `https://<TEN_GITHUB>.github.io/<TEN_REPO>/?class=LOP-5A`
   - **Cổng Giáo viên (PIN mặc định `2025`):**
     `https://<TEN_GITHUB>.github.io/<TEN_REPO>/?role=teacher`

> **Mẹo cập nhật sau này:** Mỗi khi bạn chạy `npm run build`, hệ thống sẽ tự động cập nhật lại thư mục `docs/` mới nhất.

## 2. Lưu ý quan trọng khi chạy trên GitHub Pages

- **Học sinh KHÔNG cần đăng nhập Google hay Firebase:** Học sinh mở link là có sẵn bộ đề 15 câu hỏi, chọn Số máy (01–10), làm bài, chấm điểm tốc độ và xem Bảng Vinh Danh ngay.
- **Đồng bộ lớp & bài học từ Giáo viên sang học sinh trên GitHub Pages:**
  - Nếu dùng **Cloud Firestore** để đồng bộ tự động qua link `?ws=WS-...`, thầy/cô hãy vào [Firebase Console](https://console.firebase.google.com/) → **Authentication → Settings → Authorized domains** → thêm tên miền `<TEN_GITHUB>.github.io`.
  - Hoặc dùng tính năng **Xuất Lớp & Bài (.json)** và **Nhập file (.json)** trong mục *Lớp & Giao bài* (không cần đăng nhập Google).
- **Tính năng tạo câu hỏi tự động bằng Gemini AI:** GitHub Pages chỉ là máy chủ web tĩnh (không chạy Node.js để giữ bí mật `GEMINI_API_KEY`). Nếu muốn dùng tính năng tạo đề AI trực tiếp trên host riêng, hãy deploy repo này lên **Render**, **Railway**, hoặc **Google Cloud Run** với biến môi trường `GEMINI_API_KEY` và lệnh khởi chạy `npm run build && NODE_ENV=production npm start`.

## 3. Chạy thử trên máy cá nhân (Full-stack Express + Gemini AI)

```bash
npm install
cp .env.example .env
# Điền GEMINI_API_KEY vào file .env
npm run dev
```
Mở `http://localhost:3000` (Học sinh) và `http://localhost:3000/teacher` (Giáo viên, PIN: `2025`).
