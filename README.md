# EduBot Công Dân Số (TT 02/2025)
https://kendyhuynh.github.io/Edubot-ai-studio-of-google/

Ứng dụng trò chơi học tập & tự đánh giá **24 năng lực Công dân số** với 3 phân quyền tách biệt rõ ràng:
1. **Chế độ Tập trung Trên lớp (10 máy tính bảng dùng chung):** Học sinh vào đúng **Lớp học** và **Số máy (01–10)** để nhận thông báo trực tiếp và làm bài tập Thầy/Cô giao, tự động ẩn mục tự học ngoài lớp để tập trung tuyệt đối.
2. **Chế độ Cá nhân Ở nhà (Tự đánh giá 24 Năng lực theo 4 Cấp độ):** Học sinh đăng nhập **tài khoản Google cá nhân** (tài khoản mới bắt buộc khai báo **Họ tên · Lớp học · Trường học**), luyện tập **96 bài tập tương tác đa dạng 5 hình thức** (Tình huống, Đúng/Sai, Sắp xếp quy trình 4 bước, Ghép cặp, Phân loại) trải đều 24 năng lực (1.1 → 6.3) và nhận **Huy hiệu khen thưởng** từ Thầy/Cô.
3. **Cổng Giáo viên / Admin:** Quản lý lớp học, soạn câu hỏi AI, theo dõi tiến độ 24 năng lực của từng học sinh tự học theo Lớp/Trường, xuất Excel (CSV) và gửi **Khen thưởng + Điểm cộng XP**.

## 1. Bảo mật & Phân quyền

- **Không còn mã PIN mặc định `2025`:**
  - Khi mở **Cổng Giáo Viên** lần đầu trên máy chủ, thầy/cô tự tạo mã PIN bảo mật riêng (tối thiểu 6 ký tự, mã hóa băm `scrypt`) hoặc đăng nhập trực tiếp bằng **tài khoản Google Admin** (`huynh.nhu.y1601@gmail.com`).
  - Trong mục **Bảo mật & Admin**, thầy/cô có thể **đổi mã PIN bất cứ lúc nào**, **bật chế độ Chỉ Admin Google (khóa hẳn đăng nhập bằng PIN)**, và thêm/gỡ email giáo viên đồng quản trị.
- **Tách biệt quyền Học sinh & Giáo viên:**
  - Mọi link chia sẻ cho lớp học (`?class=LOP-5A`, `?tablet=1`, `?ws=...`) đều **tự động bật Chế độ Tập trung Trên lớp**, ẩn nút Cổng Giáo Viên & mục tự đánh giá ở nhà, không gửi đáp án về máy học sinh.
  - Tài khoản Google của học sinh ở chế độ Tự đánh giá (`?mode=home`) được gán quyền `student` riêng biệt (chỉ đọc/ghi hồ sơ của chính mình) và bị từ chối tự động nếu cố truy cập đường dẫn `/teacher` hoặc `/?role=teacher`.

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
   - **Chế độ Trên lớp — Tập trung (10 máy tính bảng, KHÔNG cần đăng nhập, tự ẩn nút Giáo viên):**
     `https://<TEN_GITHUB>.github.io/<TEN_REPO>/?class=LOP-5A`
   - **Chế độ Ở nhà — Tự đánh giá 24 Năng lực (Học sinh đăng nhập Google, nhập Tên · Lớp · Trường):**
     `https://<TEN_GITHUB>.github.io/<TEN_REPO>/?mode=home`
   - **Cổng Giáo viên / Admin (chỉ tài khoản Google Admin được phép vào mặc định trên GitHub Pages):**
     `https://<TEN_GITHUB>.github.io/<TEN_REPO>/?role=teacher`

> **Lưu ý khi dùng Google Admin & Đăng nhập Google Học sinh trên GitHub Pages:** Hãy vào [Firebase Console](https://console.firebase.google.com/) → **Authentication → Settings → Authorized domains** → thêm tên miền `<TEN_GITHUB>.github.io`.

## 3. Chạy thử trên máy cá nhân (Full-stack Express + Gemini AI)

```bash
npm install
cp .env.example .env
# Điền GEMINI_API_KEY (và tùy chọn TEACHER_PIN, ADMIN_EMAILS) vào file .env
npm run dev
```
Mở `http://localhost:3000` (Học sinh) và `http://localhost:3000/teacher` (Giáo viên / Admin).
