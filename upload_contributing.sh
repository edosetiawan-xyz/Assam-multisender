#!/bin/bash

# Membuat atau menimpa file CONTRIBUTING.md
cat > CONTRIBUTING.md <<EOL
# 🛠️ Panduan Kontribusi - Assam Multisender

Terima kasih telah tertarik untuk berkontribusi pada proyek ini! Berikut adalah panduan langkah demi langkah untuk mulai berkontribusi.  

## 🏗️ Cara Berkontribusi

1️⃣ **Fork Repo**  
   - Klik tombol **Fork** di halaman GitHub proyek ini.  

2️⃣ **Clone Repo ke Komputer Anda**  
   ```bash
   git clone https://github.com/your-username/Assam-multisender.git
   cd Assam-multisender
   ```

3️⃣ **Buat Branch Baru**  
   ```bash
   git checkout -b fitur-baru
   ```

4️⃣ **Lakukan Perubahan & Commit**  
   ```bash
   git add .
   git commit -m "✨ Menambahkan fitur baru"
   ```

5️⃣ **Kirim Pull Request (PR)**  
   ```bash
   git push origin fitur-baru
   ```
   - Lalu ajukan **Pull Request (PR)** ke branch `main` dari repo utama.

## 📌 Peraturan Koding
✅ **Gunakan Standar Kode yang Konsisten**  
✅ **Uji Semua Perubahan Sebelum Commit**  
✅ **Hindari Duplikasi Kode**  
✅ **Dokumentasikan Perubahan Besar**  

🎉 **Terima kasih atas kontribusi Anda!** 🚀  
EOL

# Menampilkan isi file untuk verifikasi
echo "✅ File CONTRIBUTING.md berhasil dibuat!"
cat CONTRIBUTING.md

# Commit & Push ke GitHub
git add CONTRIBUTING.md
git commit -m "🛠️ Added CONTRIBUTING.md for contribution guidelines"
git push origin main

echo "🚀 CONTRIBUTING.md telah diunggah ke GitHub!"
