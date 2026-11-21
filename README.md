# EduBot Công Dân Số (TT 02/2025)

Ứng dụng trò chơi học tập & đánh giá **24 năng lực Công dân số** dành cho lớp học dùng chung 10 máy tính bảng, tách riêng **Cổng Học sinh** và **Cổng Giáo viên / Admin** với cơ chế phân quyền bảo mật.

## 1. Bảo mật & Phân quyền Giáo viên / Admin

- **Không còn mã PIN mặc định `2025`:**
  - Khi mở **Cổng Giáo Viên** lần đầu trên máy chủ, thầy/cô tự tạo mã PIN bảo mật riêng (tối thiểu 6 ký tự, mã hóa băm `scrypt`) hoặc đăng nhập trực tiếp bằng **tài khoản Google Admin** (`huynh.nhu.y1601@gmail.com`).
  - Trong mục **Bảo mật & Admin**, thầy/cô có thể **đổi mã PIN bất cứ lúc nào**, **bật chế độ Chỉ Admin Google (khóa hẳn đăng nhập bằng PIN)**, và thêm/gỡ email giáo viên đồng quản trị.
- **Khóa giao diện trên 10 máy tính bảng học sinh:**
  - Mọi link chia sẻ cho lớp học (`?class=LOP-5A`, `?tablet=1`, `?ws=...`) đều **tự động ẩn nút Cổng Giáo Viên** và không gửi đáp án về máy học sinh.
  - Tài khoản Google của học sinh sẽ bị từ chối tự động nếu cố truy cập đường dẫn `/teacher` hoặc `/?role=teacher`.

## 2. Đẩy lên GitHub từ AI Studio & bật GitHub Pages (Không cần quyền Workflows)

Dự án đã build sẵn bản chạy tĩnh tối ưu cho GitHub Pages ngay trong thư mục **`docs/`** (không chứa `.github/workflows/` để nút **Push to GitHub** của AI Studio hoạt động ngay lập tức).

### Bước 1: Đẩy mã nguồn lên GitHub
- Bấm nút **Push to GitHub** ngay trên AI Studio (hoặc đẩy bằng Git lên nhánh `main`).
- Chọn chế độ **Public** cho repository để dùng GitHub Pages miễn phí.

### Bước 2: Bật GitHub Pages
1. Mở repository trên GitHub → chọn tab **Settings** → mục **Pages**.
2. Ở phần **Build and deployment → Source**, giữ nguyên **Deploy from a branch**.
3. Chọn Branch: **`main`**, Folder: **`/docs`** → bấm **Save**.
4. Đường dẫn web công khai của bạn sẽ có dạng:
   - **Cổng Học sinh (10 máy tính bảng, KHÔNG cần đăng nhập, tự ẩn nút Giáo viên):**
     `https://<TEN_GITHUB>.github.io/<TEN_REPO>/?class=LOP-5A`
   - **Cổng Giáo viên / Admin (chỉ tài khoản Google Admin được phép vào mặc định trên GitHub Pages):**
     `https://<TEN_GITHUB>.github.io/<TEN_REPO>/?role=teacher`

> **Lưu ý khi dùng Google Admin trên GitHub Pages:** Hãy vào [Firebase Console](https://console.firebase.google.com/) → **Authentication → Settings → Authorized domains** → thêm tên miền `<TEN_GITHUB>.github.io`.

## 3. Chạy thử trên máy cá nhân (Full-stack Express + Gemini AI)

```bash
npm install
cp .env.example .env
# Điền GEMINI_API_KEY (và tùy chọn TEACHER_PIN, ADMIN_EMAILS) vào file .env
npm run dev
```
Mở `http://localhost:3000` (Học sinh) và `http://localhost:3000/teacher` (Giáo viên / Admin).
