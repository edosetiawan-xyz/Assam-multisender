📜 Full Changelog: Assam-multisender

🔥 25 Maret 2025 - Major Update


---

✨ Fitur Baru & Peningkatan

🖥️ Peningkatan UI CLI

Tampilan lebih modern dengan efek warna gradasi menggunakan gradient-string.

Animasi teks di CLI menggunakan chalk-animation untuk tampilan lebih menarik.

Pesan error lebih jelas dengan format ❌ Error in [context]: [message].


📩 Integrasi Telegram Ditingkatkan

Menambahkan delay notifikasi Telegram agar tidak terlalu cepat mengirim pesan.

Perbaikan pengiriman pesan menggunakan format MarkdownV2 untuk menghindari error.

Menampilkan link transaksi Assam Tea Explorer dalam pesan notifikasi Telegram.


⚡ Optimasi Logging & Debugging

Pesan error lebih berwarna dengan gradient dinamis.

Informasi transaksi lebih detail di log CLI dan Telegram.


🛠️ Perbaikan & Refaktor Kode

Refaktor Struktur Warna

Menambahkan berbagai kombinasi gradient warna untuk meningkatkan keterbacaan.

Fungsi getRandomColor() sekarang memilih warna cerah secara acak.


⚠️ Handling Gas & Transaksi

Pengecekan jaringan padat lebih akurat menggunakan rasio maxFeePerGas dan baseFee.

Retry transaksi otomatis dengan peningkatan gas jika transaksi gagal.


🔄 Perbaikan Estimasi Gas

Dukungan penuh untuk EIP-1559 dengan maxFeePerGas & maxPriorityFeePerGas.

Estimasi waktu transaksi lebih akurat berdasarkan harga gas terkini.



🗑️ Penghapusan / Pembersihan

🚀 Penghapusan kode lama yang tidak digunakan untuk meningkatkan kecepatan eksekusi.

Optimasi CLI agar lebih responsif & mengurangi delay yang tidak perlu.



---

🔄 Perubahan Dataset & Struktur File

📂 Update Struktur Dataset

Penggantian felicia_extracted.zip dengan Address.zip untuk organisasi yang lebih baik.

Sebelumnya: felicia_extracted.zip berisi 13 file CSV, masing-masing 100.000 alamat.

Sekarang: Address.zip berisi 102 file CSV, masing-masing 5000 alamat.

Penambahan Developer_Address.csv dengan format CSV yang valid.

Duplikasi alamat dicek tetapi tetap dipertahankan sesuai permintaan.


🔧 Peningkatan Struktur File

File dataset lama dihapus (felicia_extracted.zip).

Nama file lebih konsisten:

felicia_1.csv → Address_1.csv, felicia_13.csv → Address_102.csv.


Peningkatan kejelasan & kemudahan penggunaan dataset dalam sistem multisender.



---

🖥️ Peningkatan CLI & UX

Menambahkan opsi baru untuk input alamat:

Manual Input – Memasukkan alamat satu per satu.

Upload CSV – Memproses data dari file CSV.

Acak Jumlah – Menentukan jumlah acak untuk setiap transaksi.


Optimasi Progress Bar & Estimasi Waktu

Menampilkan progress bar lebih akurat.

Estimasi waktu transaksi kini lebih realistis berdasarkan jumlah transaksi dan delay.


⚠️ Error Handling Lebih Baik

Jika transaksi gagal, sistem akan mencoba kembali secara otomatis hingga maxRetries.

Notifikasi Telegram tetap dikirim meskipun transaksi gagal.




---

📢 Dokumentasi Diperbarui

📸 README diperbarui:

Ditambahkan contoh gambar notifikasi Telegram untuk referensi.

Dijelaskan cara menggunakan fitur retry & delay dalam transaksi.




---
🚀 Kesimpulan

Pembaruan ini membawa peningkatan signifikan dalam UX CLI, stabilitas transaksi, integrasi Telegram, dan struktur dataset. Jika ada pertanyaan atau masukan, silakan cek repository di:

🔗 GitHub Assam-multisender


