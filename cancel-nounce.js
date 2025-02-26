import { ethers } from 'ethers';
import dotenv from 'dotenv';
import chalk from 'chalk';
import readline from 'readline';

// Load konfigurasi dari .env
dotenv.config();

// Buat interface untuk input user
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Gunakan provider dari RPC yang diberikan
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

async function cancelAllPendingTransactions() {
    console.log(chalk.cyan("?? Program Pembatalan Semua Nonce Tertunda ??"));
    console.log(chalk.cyan("==========================================="));
    
    try {
        // Ambil private key dan buat wallet
        const privateKeys = process.env.PRIVATE_KEYS ? process.env.PRIVATE_KEYS.split(",") : [];
        if (privateKeys.length === 0) {
            console.log(chalk.red("? PRIVATE_KEYS tidak ditemukan di .env!"));
            return;
        }
        
        const wallet = new ethers.Wallet(privateKeys[0], provider);
        console.log(chalk.green(`?? Wallet digunakan: ${wallet.address}`));
        
        // Dapatkan nonce terbaru
        const currentNonce = await provider.getTransactionCount(wallet.address, "latest");
        const pendingNonce = await provider.getTransactionCount(wallet.address, "pending");
        
        console.log(chalk.yellow(`?? Nonce terakhir (latest): ${currentNonce}`));
        console.log(chalk.yellow(`? Nonce pending: ${pendingNonce}`));
        
        // Jika tidak ada transaksi pending, keluar
        if (currentNonce === pendingNonce) {
            console.log(chalk.green("? Tidak ada transaksi pending yang perlu dibatalkan."));
            rl.close();
            return;
        }
        
        // Tanya user tentang gas price
        const defaultGasPrice = 30;
        const gasPriceInput = await question(chalk.magenta(`? Masukkan gas price dalam GWEI [default: ${defaultGasPrice}]: `));
        const gasPrice = gasPriceInput ? parseInt(gasPriceInput) : defaultGasPrice;
        
        console.log(chalk.cyan(`?? Akan membatalkan semua nonce dari ${currentNonce} sampai ${pendingNonce-1}`));
        const confirm = await question(chalk.red("?? Lanjutkan pembatalan? (y/n): "));
        
        if (confirm.toLowerCase() !== 'y') {
            console.log(chalk.yellow("?? Operasi dibatalkan."));
            rl.close();
            return;
        }
        
        // Buat dan kirim transaksi 0 ETH ke diri sendiri untuk setiap nonce yang tertunda
        for (let nonceToCancel = currentNonce; nonceToCancel < pendingNonce; nonceToCancel++) {
            try {
                console.log(chalk.yellow(`?? Membatalkan transaksi dengan nonce ${nonceToCancel}...`));
                
                // Buat transaksi dengan gas price yang tinggi untuk "menggantikan" transaksi tertunda
                const tx = {
                    to: wallet.address, // Kirim ke diri sendiri
                    value: 0, // 0 ETH
                    nonce: nonceToCancel,
                    // Gas price tinggi untuk memastikan transaksi ini diprioritaskan
                    gasPrice: ethers.parseUnits(gasPrice.toString(), "gwei"),
                    // Gas limit aman untuk transaksi sederhana
                    gasLimit: 21000
                };
                
                // Kirim transaksi
                const response = await wallet.sendTransaction(tx);
                console.log(chalk.green(`  ? Transaksi pembatalan dikirim: ${response.hash}`));
                
                // Tunggu konfirmasi (opsional - bisa dihapus jika ingin lebih cepat)
                console.log(chalk.yellow(`  ? Menunggu konfirmasi...`));
                await response.wait();
                console.log(chalk.green(`  ?? Transaksi dengan nonce ${nonceToCancel} berhasil dibatalkan!`));
            } catch (error) {
                console.log(chalk.red(`  ? Gagal membatalkan nonce ${nonceToCancel}: ${error.message}`));
            }
        }
        
        console.log(chalk.green("? Proses pembatalan nonce selesai!"));
    } catch (error) {
        console.log(chalk.red(`? Error: ${error.message}`));
    } finally {
        rl.close();
    }
}

// Jalankan fungsi pembatalan
cancelAllPendingTransactions();
