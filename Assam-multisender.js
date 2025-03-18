import fs from "fs"
import path from "path"
import readline from "readline-sync"
import chalk from "chalk"
import { ethers } from "ethers"
import dotenv from "dotenv"

dotenv.config()

// Konfigurasi provider dan wallet
const RPC_URLS = process.env.RPC_URLS ? process.env.RPC_URLS.split(",") : [process.env.RPC_URL]
let currentRpcIndex = 0

// Tracking nonce yang sudah digunakan dalam session ini
const usedNonces = new Set()
// Tracking transaksi pending
const pendingTransactions = new Map() // txHash -> {timestamp, nonce, recipient}
// Waktu maksimum transaksi pending (dalam detik) sebelum dianggap stuck
const MAX_PENDING_TIME = 180 // 3 menit

function logError(context, error, additionalInfo = {}) {
  const timestamp = new Date().toISOString()
  console.log(chalk.hex("#FF3131")(`❌ Error in ${context}: ${error.message}`))
}

function getNextProvider() {
  try {
    const url = RPC_URLS[currentRpcIndex]
    currentRpcIndex = (currentRpcIndex + 1) % RPC_URLS.length
    return new ethers.JsonRpcProvider(url)
  } catch (error) {
    logError("Provider Setup", error)
    throw new Error("Failed to initialize provider")
  }
}

let provider = getNextProvider()

const privateKeys = process.env.PRIVATE_KEYS ? process.env.PRIVATE_KEYS.split(",") : []
if (privateKeys.length === 0) {
  console.log(chalk.hex("#FF3131")("❌ PRIVATE_KEYS tidak ditemukan di .env!"))
  process.exit(1)
}

const wallets = privateKeys.map((key) => new ethers.Wallet(key, provider))

// Daftar token yang didukung
const tokens = {
  BTC: process.env.BTC_CONTRACT,
  MTT: process.env.MTT_CONTRACT,
  TDI: process.env.TDI_CONTRACT,
}

let telegramNotificationDelay = 0

function escapeMarkdownV2(text) {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&")
}

async function sendTelegramMessage(message, txHash = null) {
  try {
    await new Promise((resolve) => setTimeout(resolve, telegramNotificationDelay * 1000))

    // Jika ada hash transaksi, tambahkan link explorer
    let finalMessage = message
    if (txHash) {
      const explorerLink = `https://assam.tea.xyz/tx/${txHash}`
      finalMessage += `\n🔍 Explorer: ${explorerLink}`
    }

    const escapedMessage = escapeMarkdownV2(finalMessage)
    const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`
    const body = JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: escapedMessage,
      parse_mode: "MarkdownV2",
    })

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })

    const result = await response.json()

    if (!response.ok || !result.ok) {
      throw new Error(result.description || "Unknown Telegram error")
    }
    console.log(chalk.hex("#FF00FF")("📩 Notifikasi Telegram ") + chalk.hex("#00FFFF")("berhasil dikirim!"))
  } catch (error) {
    logError("Telegram Notification", error)
  }
}

// Fungsi untuk mendapatkan nonce yang valid dan belum digunakan
async function getValidNonce(wallet, forceRefresh = false) {
  try {
    // Selalu dapatkan nonce terbaru dari network jika forceRefresh = true
    const currentNonce = forceRefresh
      ? await provider.getTransactionCount(wallet.address, "pending")
      : await provider.getTransactionCount(wallet.address, "pending")

    // Cek apakah nonce sudah digunakan dalam session ini
    let nonce = currentNonce
    while (usedNonces.has(nonce)) {
      nonce++
    }

    return nonce
  } catch (error) {
    logError("Get Valid Nonce", error)
    // Jika gagal mendapatkan nonce, coba dengan provider lain
    provider = getNextProvider()
    const newWallet = new ethers.Wallet(wallet.privateKey, provider)
    return await getValidNonce(newWallet, true)
  }
}

// Fungsi untuk memeriksa network congestion
async function checkNetworkCongestion() {
  try {
    const feeData = await provider.getFeeData()

    // Jika menggunakan EIP-1559
    if (feeData.maxFeePerGas) {
      // Hitung rasio maxPriorityFeePerGas terhadap baseFee
      const baseFee = feeData.lastBaseFeePerGas || BigInt(0)
      const priorityFee = feeData.maxPriorityFeePerGas || BigInt(0)

      if (baseFee === BigInt(0)) return { congested: false, level: 0 }

      const ratio = Number((priorityFee * BigInt(100)) / baseFee)

      // Tentukan level congestion
      if (ratio > 50) return { congested: true, level: 3 } // Sangat padat
      if (ratio > 30) return { congested: true, level: 2 } // Padat
      if (ratio > 15) return { congested: true, level: 1 } // Sedikit padat
      return { congested: false, level: 0 } // Normal
    }
    // Jika tidak menggunakan EIP-1559
    else {
      // Gunakan gas price sebagai indikator
      const gasPrice = feeData.gasPrice || BigInt(0)
      const gasPriceGwei = Number(ethers.formatUnits(gasPrice, "gwei"))

      // Threshold bisa disesuaikan berdasarkan jaringan
      if (gasPriceGwei > 100) return { congested: true, level: 3 }
      if (gasPriceGwei > 50) return { congested: true, level: 2 }
      if (gasPriceGwei > 20) return { congested: true, level: 1 }
      return { congested: false, level: 0 }
    }
  } catch (error) {
    logError("Check Network Congestion", error)
    return { congested: false, level: 0 } // Default jika error
  }
}

// Fungsi untuk menghitung gas parameters berdasarkan kondisi jaringan
async function calculateGasParameters(increasePercentage = 0) {
  try {
    const feeData = await provider.getFeeData()
    const congestion = await checkNetworkCongestion()

    // Tambahkan persentase berdasarkan congestion level
    let totalIncrease = increasePercentage
    if (congestion.congested) {
      const congestionIncrease = [10, 20, 40][congestion.level - 1] || 0
      totalIncrease += congestionIncrease
      console.log(
        chalk.hex("#FFFF00")(`⚠️ Jaringan padat (level ${congestion.level}), menambah gas +${congestionIncrease}%`),
      )
    }

    const multiplier = 1 + totalIncrease / 100

    // Jika mendukung EIP-1559
    if (feeData.maxFeePerGas) {
      const maxPriorityFeePerGas = BigInt(Math.floor(Number(feeData.maxPriorityFeePerGas) * multiplier))
      const maxFeePerGas = feeData.lastBaseFeePerGas
        ? BigInt(Math.floor(Number(feeData.lastBaseFeePerGas) * 2)) + maxPriorityFeePerGas
        : BigInt(Math.floor(Number(feeData.maxFeePerGas) * multiplier))

      return {
        type: 2, // EIP-1559
        maxPriorityFeePerGas,
        maxFeePerGas,
        supportsEIP1559: true,
      }
    }
    // Jika tidak mendukung EIP-1559
    else {
      return {
        type: 0, // Legacy
        gasPrice: BigInt(Math.floor(Number(feeData.gasPrice) * multiplier)),
        supportsEIP1559: false,
      }
    }
  } catch (error) {
    logError("Calculate Gas Parameters", error)
    // Fallback ke provider lain jika error
    provider = getNextProvider()
    return calculateGasParameters(increasePercentage)
  }
}

// Fungsi untuk memeriksa transaksi yang stuck
async function checkStuckTransactions(wallet) {
  const now = Date.now()
  const stuckTxs = []

  for (const [txHash, txInfo] of pendingTransactions.entries()) {
    // Jika transaksi sudah pending lebih dari MAX_PENDING_TIME
    if (now - txInfo.timestamp > MAX_PENDING_TIME * 1000) {
      try {
        // Cek status transaksi
        const tx = await provider.getTransaction(txHash)

        // Jika transaksi masih pending (belum di-mine)
        if (tx && !tx.blockNumber) {
          stuckTxs.push({
            hash: txHash,
            nonce: txInfo.nonce,
            recipient: txInfo.recipient,
          })
        }
        // Jika transaksi sudah selesai atau tidak ditemukan, hapus dari tracking
        else {
          pendingTransactions.delete(txHash)
        }
      } catch (error) {
        // Jika error saat mengecek transaksi, anggap masih pending
        logError(`Check Tx ${txHash}`, error)
      }
    }
  }

  // Jika ada transaksi yang stuck, coba cancel
  if (stuckTxs.length > 0) {
    console.log(chalk.hex("#FFFF00")(`⚠️ Ditemukan ${stuckTxs.length} transaksi stuck, mencoba cancel...`))

    for (const stuckTx of stuckTxs) {
      await cancelStuckTransaction(wallet, stuckTx)
    }
  }

  return stuckTxs.length > 0
}

// Fungsi untuk membatalkan transaksi yang stuck
async function cancelStuckTransaction(wallet, stuckTx) {
  try {
    console.log(chalk.hex("#FFFF00")(`⏳ Membatalkan transaksi stuck: ${stuckTx.hash} (nonce: ${stuckTx.nonce})`))

    // Dapatkan gas parameters dengan peningkatan 50% untuk memastikan cancel berhasil
    const gasParams = await calculateGasParameters(50)

    // Buat transaksi 0 value ke diri sendiri dengan nonce yang sama
    const tx = {
      to: wallet.address,
      value: 0n,
      nonce: stuckTx.nonce,
      ...(gasParams.supportsEIP1559
        ? {
            type: 2,
            maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
            maxFeePerGas: gasParams.maxFeePerGas,
          }
        : {
            gasPrice: gasParams.gasPrice,
          }),
      gasLimit: 21000,
    }

    // Kirim transaksi cancel
    const response = await wallet.sendTransaction(tx)
    console.log(chalk.hex("#00FF00")(`✅ Transaksi cancel dikirim: ${response.hash}`))

    // Tunggu konfirmasi
    const receipt = await response.wait()

    if (receipt && receipt.status === 1) {
      console.log(chalk.hex("#00FF00")(`✅ Transaksi dengan nonce ${stuckTx.nonce} berhasil dibatalkan!`))
      pendingTransactions.delete(stuckTx.hash)

      // Kirim notifikasi Telegram
      const message =
        `🚫 Transaksi Stuck Dibatalkan\n` +
        `👛 Wallet: ${wallet.address}\n` +
        `🔢 Nonce: ${stuckTx.nonce}\n` +
        `🏷️ Transaksi asli: ${stuckTx.hash}\n` +
        `✅ Transaksi pembatalan: ${response.hash}\n` +
        `⏰ Waktu: ${new Date().toLocaleString()}`

      await sendTelegramMessage(message, response.hash)
      return true
    }

    return false
  } catch (error) {
    logError("Cancel Stuck Transaction", error)
    return false
  }
}

// Fungsi untuk estimasi gas limit
async function estimateGasLimit(tokenContract, recipient, amountInWei) {
  try {
    // Estimasi gas untuk transaksi token
    const gasEstimate = await tokenContract.transfer.estimateGas(recipient, amountInWei)

    // Tambahkan buffer 20% untuk keamanan
    return BigInt(Math.floor(Number(gasEstimate) * 1.2))
  } catch (error) {
    logError("Estimate Gas", error)
    // Fallback ke gas limit default jika estimasi gagal
    return 100000n
  }
}

async function sendTransactionWithRetry(
  wallet,
  tokenAddress,
  recipient,
  amount,
  tokenSymbol,
  currentIndex,
  totalTx,
  suggestedNonce = null,
  maxRetries = 5,
) {
  let retries = 0
  const baseDelay = 1000
  let nonce = suggestedNonce !== null ? suggestedNonce : await getValidNonce(wallet)
  let lastError = null

  // Cek dan tangani transaksi yang stuck sebelum mengirim yang baru
  await checkStuckTransactions(wallet)

  // Daftar persentase kenaikan gas untuk setiap percobaan
  const gasIncreasePercentages = [0, 10, 20, 30, 40]

  while (retries < maxRetries) {
    try {
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ["function transfer(address to, uint256 value) public returns (bool)"],
        wallet,
      )
      const amountInWei = ethers.parseUnits(amount.toString(), 18)

      try {
        await provider.getNetwork()
      } catch (networkError) {
        logError("Network Check", networkError, { attempt: retries + 1 })
        provider = getNextProvider()
        wallet = new ethers.Wallet(wallet.privateKey, provider)
        throw new Error("Network check failed, switching provider")
      }

      console.log(chalk.hex("#FF3131")(`🚀 Mengirim ${amount} ${tokenSymbol} ke ${recipient}`))
      console.log(
        chalk.hex("#FF00FF")("• felicia ") +
          chalk.hex("#FFFF00")(`(${currentIndex + 1}/${totalTx}) `) +
          chalk.hex("#00FFFF")("edosetiawan.eth"),
      )

      // Cek apakah nonce sudah digunakan dalam session ini
      if (usedNonces.has(nonce)) {
        console.log(
          chalk.hex("#FFFF00")(`⚠️ Nonce ${nonce} sudah digunakan dalam session ini, mendapatkan nonce baru...`),
        )
        nonce = await getValidNonce(wallet, true)
        console.log(chalk.hex("#00FFFF")(`🔢 Nonce baru: ${nonce}`))
      }

      // Tandai nonce sebagai digunakan
      usedNonces.add(nonce)

      // Hitung gas parameters untuk percobaan ini
      const increasePercentage = gasIncreasePercentages[Math.min(retries, gasIncreasePercentages.length - 1)]
      const gasParams = await calculateGasParameters(increasePercentage)

      // Estimasi gas limit
      const gasLimit = await estimateGasLimit(tokenContract, recipient, amountInWei)

      // Log informasi gas
      if (gasParams.supportsEIP1559) {
        console.log(
          chalk.hex("#FFFF00")(
            `⛽ EIP-1559: maxPriorityFee: ${ethers.formatUnits(gasParams.maxPriorityFeePerGas, "gwei")} Gwei, ` +
              `maxFee: ${ethers.formatUnits(gasParams.maxFeePerGas, "gwei")} Gwei ` +
              `(${increasePercentage > 0 ? `+${increasePercentage}%` : "normal"})`,
          ),
        )
      } else {
        console.log(
          chalk.hex("#FFFF00")(
            `⛽ Gas Price: ${ethers.formatUnits(gasParams.gasPrice, "gwei")} Gwei ` +
              `(${increasePercentage > 0 ? `+${increasePercentage}%` : "normal"})`,
          ),
        )
      }

      console.log(chalk.hex("#FFFF00")(`🔢 Menggunakan nonce: ${nonce}, Gas Limit: ${gasLimit}`))

      // Buat transaksi dengan parameter gas yang sesuai
      const txOptions = {
        nonce,
        gasLimit,
        ...(gasParams.supportsEIP1559
          ? {
              type: 2,
              maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
              maxFeePerGas: gasParams.maxFeePerGas,
            }
          : {
              gasPrice: gasParams.gasPrice,
            }),
      }

      const tx = await tokenContract.transfer(recipient, amountInWei, txOptions)

      console.log(chalk.hex("#00FF00")(`✅ Transaksi dikirim: ${tx.hash}`))

      // Tambahkan ke daftar transaksi pending
      pendingTransactions.set(tx.hash, {
        timestamp: Date.now(),
        nonce,
        recipient,
      })

      const estimatedTime = await estimateTransactionTime(
        gasParams.supportsEIP1559 ? gasParams.maxFeePerGas : gasParams.gasPrice,
      )

      const timestamp = new Date()
      const formattedTimestamp = `${timestamp.getDate()} ${timestamp.toLocaleString("default", { month: "long" })} ${timestamp.getFullYear()} ${timestamp.getHours()}:${timestamp.getMinutes()}:${timestamp.getSeconds()}`

      const message =
        `🚀 Mengirim ${amount} ${tokenSymbol} ke ${recipient}\n` +
        `• felicia (${currentIndex + 1}/${totalTx}) edosetiawan.eth\n` +
        `✅ Transaksi dikirim: ${tx.hash}\n` +
        `⏱️ Estimasi waktu: ${estimatedTime}\n` +
        `⛽ ${
          gasParams.supportsEIP1559
            ? `Max Priority Fee: ${ethers.formatUnits(gasParams.maxPriorityFeePerGas, "gwei")} Gwei, Max Fee: ${ethers.formatUnits(gasParams.maxFeePerGas, "gwei")} Gwei`
            : `Gas Price: ${ethers.formatUnits(gasParams.gasPrice, "gwei")} Gwei`
        }\n` +
        `⏰ Waktu transaksi: ${formattedTimestamp}`

      await sendTelegramMessage(message, tx.hash)
      console.log(chalk.hex("#00FFFF")(message))

      const receipt = await tx.wait()

      // Hapus dari daftar transaksi pending
      pendingTransactions.delete(tx.hash)

      return "SUKSES"
    } catch (err) {
      lastError = err
      logError("Transaction", err)

      if (err.message.includes("insufficient funds")) {
        console.log(chalk.hex("#FF3131")("❌ Dana tidak mencukupi! Membatalkan transaksi."))
        // Hapus nonce dari daftar yang digunakan karena transaksi gagal
        usedNonces.delete(nonce)
        return "GAGAL"
      }

      // Cek apakah error terkait nonce
      if (
        err.message.includes("nonce too low") ||
        err.message.includes("already known") ||
        err.message.includes("replacement transaction underpriced") ||
        err.message.includes("nonce has already been used")
      ) {
        console.log(chalk.hex("#FFFF00")("⚠️ Nonce conflict detected. Getting new nonce..."))
        // Hapus nonce lama dari daftar yang digunakan
        usedNonces.delete(nonce)
        // Dapatkan nonce baru yang lebih tinggi
        nonce = await getValidNonce(wallet, true)
        console.log(chalk.hex("#00FFFF")(`🔢 Nonce baru: ${nonce}`))
      }
      // Cek apakah error terkait gas price
      else if (
        err.message.includes("gas price too low") ||
        err.message.includes("max fee per gas less than block base fee") ||
        err.message.includes("transaction underpriced") ||
        err.message.includes("fee cap less than block base fee")
      ) {
        console.log(chalk.hex("#FFFF00")("⚠️ Gas price terlalu rendah. Meningkatkan gas price..."))
        // Tidak perlu mengubah nonce karena transaksi dengan nonce ini belum masuk ke blockchain
      }
      // Error lainnya
      else {
        // Hapus nonce dari daftar yang digunakan untuk error yang tidak terkait nonce
        usedNonces.delete(nonce)
      }

      retries++
      if (retries < maxRetries) {
        const waitTime = Math.min(baseDelay * Math.pow(2, retries), 30000)
        console.log(
          chalk.hex("#FFFF00")(
            `⏳ Menunggu ${waitTime / 1000} detik sebelum mencoba lagi (Percobaan ${retries + 1}/${maxRetries})...`,
          ),
        )
        await new Promise((resolve) => setTimeout(resolve, waitTime))
      }
    }
  }

  console.log(
    chalk.hex("#FF3131")(`❌ Gagal setelah ${maxRetries} percobaan: ${lastError?.message || "Unknown error"}`),
  )
  // Hapus nonce dari daftar yang digunakan karena semua percobaan gagal
  usedNonces.delete(nonce)
  return "GAGAL"
}

function selectCSVFile() {
  try {
    const files = fs
      .readdirSync(".")
      .filter((file) => file.startsWith("felicia_") && file.endsWith(".csv"))
      .sort((a, b) => {
        const numA = Number.parseInt(a.match(/\d+/)?.[0] || "0")
        const numB = Number.parseInt(b.match(/\d+/)?.[0] || "0")
        return numA - numB
      })

    if (files.length === 0) {
      console.log(chalk.hex("#FF1493")("❌ Tidak ada file CSV yang ditemukan!"))
      process.exit(1)
    }

    console.log(chalk.hex("#FF00FF")("\n╔═══════════════════════╗"))
    console.log(chalk.hex("#FF00FF")("║    PILIH FILE CSV     ║"))
    console.log(chalk.hex("#FF00FF")("╚═══════════════════════╝\n"))

    files.forEach((file, index) => {
      console.log(chalk.hex("#00FFFF")(`[${index + 1}] ${file}`))
    })
    console.log(chalk.hex("#FF1493")("[0] CANCEL"))

    while (true) {
      const input = readline.question(chalk.hex("#00FFFF")("\n➤ Pilih file CSV (0-" + files.length + "): "))
      const choice = Number.parseInt(input)

      if (input.trim() === "0") {
        console.log(chalk.hex("#FF1493")("❌ Operasi dibatalkan oleh user."))
        process.exit(0)
      }

      if (!isNaN(choice) && choice > 0 && choice <= files.length) {
        return files[choice - 1]
      }

      console.log(chalk.hex("#FF3131")("❌ Pilihan tidak valid! Silakan coba lagi."))
    }
  } catch (error) {
    logError("File Selection", error)
    console.log(chalk.hex("#FF3131")("❌ Terjadi kesalahan saat memilih file!"))
    process.exit(1)
  }
}

function chooseRetryCount() {
  while (true) {
    const input = readline.question(chalk.hex("#00FFFF")("Masukkan jumlah retry jika gagal (1-10): "))

    if (input.trim() === "0") {
      console.log(chalk.hex("#FF1493")("❌ Operasi dibatalkan."))
      process.exit(0)
    }

    const count = Number.parseInt(input)
    if (!isNaN(count) && count >= 1 && count <= 10) {
      return count
    }
    console.log(chalk.hex("#FF3131")("❌ Jumlah retry harus antara 1-10!"))
  }
}

function chooseTransactionDelay() {
  console.log(chalk.hex("#FF00FF")("\n╔═══════════════════════╗"))
  console.log(chalk.hex("#FF00FF")("║      MODE JEDA        ║"))
  console.log(chalk.hex("#FF00FF")("╚═══════════════════════╝\n"))

  console.log(chalk.hex("#00FFFF")("[1] Tanpa Jeda"))
  console.log(chalk.hex("#00FFFF")("[2] Jeda Manual"))
  console.log(chalk.hex("#00FFFF")("[3] Jeda Acak"))
  console.log(chalk.hex("#FF1493")("[0] CANCEL"))

  while (true) {
    const input = readline.question(chalk.hex("#00FFFF")("\n➤ Pilih mode jeda (0-3): "))
    const choice = Number.parseInt(input)

    if (input.trim() === "0") {
      console.log(chalk.hex("#FF1493")("❌ Operasi dibatalkan oleh user."))
      process.exit(0)
    }

    if (!isNaN(choice) && choice >= 1 && choice <= 3) {
      return choice - 1
    }

    console.log(chalk.hex("#FF3131")("❌ Pilihan tidak valid! Silakan coba lagi."))
  }
}

function setManualDelay() {
  while (true) {
    const input = readline.question(chalk.hex("#00FFFF")("Masukkan waktu jeda (0.1 - 1000 detik): "))

    if (input.trim() === "0") {
      console.log(chalk.hex("#FF1493")("❌ Dibatalkan."))
      process.exit(0)
    }

    const delay = Number.parseFloat(input)
    if (!isNaN(delay) && delay >= 0.1 && delay <= 1000) {
      return delay
    }
    console.log(chalk.hex("#FF3131")("❌ Waktu jeda harus antara 0.1 - 1000 detik!"))
  }
}

function setRandomDelayRange() {
  while (true) {
    const minInput = readline.question(chalk.hex("#00FFFF")("Masukkan waktu minimum jeda (0.1 - 1000 detik): "))

    if (minInput.trim() === "0") {
      console.log(chalk.hex("#FF1493")("❌ Dibatalkan."))
      process.exit(0)
    }

    const maxInput = readline.question(chalk.hex("#00FFFF")("Masukkan waktu maksimum jeda (0.1 - 1000 detik): "))

    if (maxInput.trim() === "0") {
      console.log(chalk.hex("#FF1493")("❌ Dibatalkan."))
      process.exit(0)
    }

    const min = Number.parseFloat(minInput)
    const max = Number.parseFloat(maxInput)

    if (!isNaN(min) && !isNaN(max) && min >= 0.1 && max <= 1000 && min < max) {
      return { min, max }
    }
    console.log(chalk.hex("#FF3131")("❌ Range jeda tidak valid! Min harus >= 0.1, Max <= 1000, dan Min < Max"))
  }
}

function getRandomDelay(min, max) {
  return Math.random() * (max - min) + min
}

function chooseBatchSize() {
  while (true) {
    const input = readline.question(chalk.hex("#00FFFF")("Masukkan jumlah transaksi per batch (1-100): "))
    const batchSize = Number.parseInt(input)
    if (!isNaN(batchSize) && batchSize >= 1 && batchSize <= 100) {
      return batchSize
    }
    console.log(chalk.hex("#FF3131")("❌ Jumlah transaksi per batch harus antara 1 dan 100!"))
  }
}

async function applyDelay(delayChoice, delayTime, randomDelayRange, currentIndex, totalTx) {
  if (currentIndex >= totalTx - 1) return

  try {
    if (delayChoice === 0) {
      return
    } else if (delayChoice === 1) {
      console.log(chalk.hex("#00FFFF")(`⏳ Menunggu ${delayTime} detik...`))
      await new Promise((resolve) => setTimeout(resolve, delayTime * 1000))
    } else if (delayChoice === 2) {
      const randomDelay = getRandomDelay(randomDelayRange.min, randomDelayRange.max)
      console.log(chalk.hex("#00FFFF")(`⏳ Jeda acak: ${randomDelay.toFixed(1)} detik`))
      await new Promise((resolve) => setTimeout(resolve, randomDelay * 1000))
    }
  } catch (error) {
    logError("Delay Application", error)
  }
}

function setTelegramDelay() {
  while (true) {
    const input = readline.question(chalk.hex("#00FFFF")("Masukkan delay notifikasi Telegram (dalam detik, 0-60): "))

    const delay = Number.parseInt(input)
    if (!isNaN(delay) && delay >= 0 && delay <= 60) {
      telegramNotificationDelay = delay
      return
    }
    console.log(chalk.hex("#FF3131")("❌ Delay harus antara 0-60 detik!"))
  }
}

function saveCheckpoint(index) {
  fs.writeFileSync("checkpoint.txt", index.toString())
}

function loadCheckpoint() {
  if (fs.existsSync("checkpoint.txt")) {
    const checkpoint = fs.readFileSync("checkpoint.txt", "utf8").trim()
    return Number.parseInt(checkpoint)
  }
  return 0
}

async function checkTeaBalance(address) {
  try {
    const balance = await provider.getBalance(address)
    return ethers.formatEther(balance)
  } catch (error) {
    logError("Check TEA Balance", error)
    return "Error"
  }
}

async function estimateTransactionTime(gasPrice) {
  const baseTime = 15 // waktu dasar dalam detik
  const gasPriceGwei = Number.parseFloat(ethers.formatUnits(gasPrice, "gwei"))
  const estimatedTime = baseTime * (10 / gasPriceGwei)

  if (estimatedTime < 60) {
    return `${Math.round(estimatedTime)} detik`
  } else if (estimatedTime < 3600) {
    return `${Math.round(estimatedTime / 60)} menit`
  } else if (estimatedTime < 86400) {
    return `${Math.round(estimatedTime / 3600)} jam`
  } else {
    return `${Math.round(estimatedTime / 86400)} hari`
  }
}

function calculateTotalEstimatedTime(totalTx, delayChoice, delayTime, randomDelayRange, batchSize) {
  let totalTime = 0
  const baseTransactionTime = 15 // Asumsi waktu dasar per transaksi

  if (delayChoice === 0) {
    totalTime = (totalTx / batchSize) * baseTransactionTime
  } else if (delayChoice === 1) {
    totalTime = totalTx * (baseTransactionTime + delayTime)
  } else if (delayChoice === 2) {
    const avgDelay = (randomDelayRange.min + randomDelayRange.max) / 2
    totalTime = totalTx * (baseTransactionTime + avgDelay)
  }

  if (totalTime < 60) {
    return `${Math.round(totalTime)} detik`
  } else if (totalTime < 3600) {
    return `${Math.round(totalTime / 60)} menit`
  } else if (totalTime < 86400) {
    return `${Math.round(totalTime / 3600)} jam`
  } else {
    return `${Math.round(totalTime / 86400)} hari`
  }
}

// Fungsi untuk membatalkan nonce
async function cancelNonce() {
  console.clear()
  console.log(
    chalk.hex("#00FFFF")(`
                                ,        ,
                                /(        )\`
                                \\ \\___   / |
                                /- _  \`-/  '
                               (/\\/ \\ \\   /\\
                               / /   | \`    \\
                               O O   ) /    |
                               \`-^--'\`<     '
                   TM         (_.)  _  )   /
|  | |\\  | ~|~ \\ /             \`.___/\`    /
|  | | \\ |  |   X                \`-----' /
\`__| |  \\| _|_ / \\  <----.     __ / __   \\
                    <----|====O)))==) \\) /====
                    <----'    \`--' \`.__,' \\
                                 |        |
                                  \\       /
                             ______( (_  / \\______
                           ,'  ,-----'   |        \\
                           \`--{__________)        \\/
                                      edosetiawan.eth
  `),
  )

  try {
    console.log(chalk.hex("#FF00FF")("\n╔════════════════════════════════════════════╗"))
    console.log(chalk.hex("#FF00FF")("║       CANCEL NONCE - ASSAM TESTNET         ║"))
    console.log(chalk.hex("#FF00FF")("╚════════════════════════════════════════════╝"))
    console.log(chalk.hex("#00FFFF")("\n╔════════════════════════════════════════════╗"))
    console.log(chalk.hex("#00FFFF")("║      AUTHOR : edosetiawan.eth              ║"))
    console.log(chalk.hex("#00FFFF")("║      E-MAIL : edosetiawan.eth@gmail.com    ║"))
    console.log(chalk.hex("#00FFFF")("║   INSTAGRAM : @edosetiawan.eth             ║"))
    console.log(chalk.hex("#00FFFF")("║   TWITTER/X : @edosetiawan_eth             ║"))
    console.log(chalk.hex("#00FFFF")("║      GITHUB : edosetiawan-xyz              ║"))
    console.log(chalk.hex("#00FFFF")("║     DISCORD : edosetiawan.eth              ║"))
    console.log(chalk.hex("#00FFFF")("╚════════════════════════════════════════════╝\n"))

    // Pilih wallet untuk membatalkan nonce
    console.log(chalk.hex("#FF00FF")("╔═════════════════════════╗"))
    console.log(chalk.hex("#FF00FF")("║      PILIH WALLET       ║"))
    console.log(chalk.hex("#FF00FF")("╚═════════════════════════╝\n"))

    // Tampilkan daftar wallet
    wallets.forEach((wallet, index) => {
      console.log(chalk.hex("#00FFFF")(`[${index + 1}] ${wallet.address}`))
    })
    console.log(chalk.hex("#FF1493")("[0] CANCEL"))

    // Pilih wallet
    let selectedWallet
    while (true) {
      const input = readline.question(chalk.hex("#00FFFF")("\n➤ Pilih wallet (0-" + wallets.length + "): "))
      const choice = Number.parseInt(input)

      if (input.trim() === "0") {
        console.log(chalk.hex("#FF1493")("❌ Operasi dibatalkan oleh user."))
        return
      }

      if (!isNaN(choice) && choice > 0 && choice <= wallets.length) {
        selectedWallet = wallets[choice - 1]
        break
      }

      console.log(chalk.hex("#FF3131")("❌ Pilihan tidak valid! Silakan coba lagi."))
    }

    // Dapatkan nonce saat ini
    const currentNonce = await provider.getTransactionCount(selectedWallet.address, "latest")
    const pendingNonce = await provider.getTransactionCount(selectedWallet.address, "pending")

    console.log(chalk.hex("#00FFFF")(`\n💼 Wallet: ${selectedWallet.address}`))
    console.log(chalk.hex("#00FFFF")(`🔢 Nonce saat ini: ${currentNonce}`))
    console.log(chalk.hex("#00FFFF")(`🔢 Nonce pending: ${pendingNonce}`))

    if (pendingNonce <= currentNonce) {
      console.log(chalk.hex("#00FF00")("\n✅ Tidak ada transaksi pending untuk dibatalkan!"))
      readline.question(chalk.hex("#00FFFF")("\nTekan Enter untuk kembali ke menu utama..."))
      return
    }

    // Tampilkan transaksi pending
    console.log(chalk.hex("#FFFF00")(`\n⚠️ Terdapat ${pendingNonce - currentNonce} transaksi pending`))

    // Pilih nonce untuk dibatalkan
    console.log(chalk.hex("#FF00FF")("\n╔═════════════════════════╗"))
    console.log(chalk.hex("#FF00FF")("║      PILIH NONCE        ║"))
    console.log(chalk.hex("#FF00FF")("╚═════════════════════════╝\n"))

    console.log(chalk.hex("#00FFFF")("[1] Batalkan semua nonce pending"))
    console.log(chalk.hex("#00FFFF")("[2] Batalkan nonce tertentu"))
    console.log(chalk.hex("#FF1493")("[0] CANCEL"))

    const noncesToCancel = []
    while (true) {
      const input = readline.question(chalk.hex("#00FFFF")("\n➤ Pilih opsi (0-2): "))
      const choice = Number.parseInt(input)

      if (input.trim() === "0") {
        console.log(chalk.hex("#FF1493")("❌ Operasi dibatalkan oleh user."))
        return
      }

      if (choice === 1) {
        // Batalkan semua nonce pending
        for (let i = currentNonce; i < pendingNonce; i++) {
          noncesToCancel.push(i)
        }
        break
      } else if (choice === 2) {
        // Batalkan nonce tertentu
        const nonceInput = readline.question(
          chalk.hex("#00FFFF")(`Masukkan nonce yang ingin dibatalkan (${currentNonce}-${pendingNonce - 1}): `),
        )
        const nonce = Number.parseInt(nonceInput)

        if (!isNaN(nonce) && nonce >= currentNonce && nonce < pendingNonce) {
          noncesToCancel.push(nonce)
          break
        }

        console.log(chalk.hex("#FF3131")("❌ Nonce tidak valid! Silakan coba lagi."))
        continue
      }

      console.log(chalk.hex("#FF3131")("❌ Pilihan tidak valid! Silakan coba lagi."))
    }

    // Konfirmasi pembatalan
    console.log(
      chalk.hex("#FFFF00")(`\n⚠️ Akan membatalkan ${noncesToCancel.length} nonce: ${noncesToCancel.join(", ")}`),
    )
    const confirm = readline.question(chalk.hex("#FFFF00")("Lanjutkan? (y/n): "))

    if (confirm.toLowerCase() !== "y") {
      console.log(chalk.hex("#FF1493")("❌ Operasi dibatalkan oleh user."))
      readline.question(chalk.hex("#00FFFF")("\nTekan Enter untuk kembali ke menu utama..."))
      return
    }

    // Dapatkan gas parameters
    const gasParams = await calculateGasParameters(50) // 50% lebih tinggi untuk memastikan cancel berhasil

    console.log(
      chalk.hex("#00FFFF")(
        `\n🚀 Membatalkan transaksi dengan ${
          gasParams.supportsEIP1559
            ? `maxPriorityFee: ${ethers.formatUnits(gasParams.maxPriorityFeePerGas, "gwei")} Gwei, maxFee: ${ethers.formatUnits(gasParams.maxFeePerGas, "gwei")} Gwei`
            : `Gas Price: ${ethers.formatUnits(gasParams.gasPrice, "gwei")} Gwei`
        }...`,
      ),
    )

    // Proses pembatalan
    let successCount = 0
    let failCount = 0

    for (const nonce of noncesToCancel) {
      try {
        console.log(chalk.hex("#FFFF00")(`\n⏳ Membatalkan nonce ${nonce}...`))

        // Buat transaksi pembatalan (0 value ke diri sendiri dengan nonce yang sama)
        const tx = {
          to: selectedWallet.address,
          value: 0n,
          nonce: nonce,
          ...(gasParams.supportsEIP1559
            ? {
                type: 2,
                maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
                maxFeePerGas: gasParams.maxFeePerGas,
              }
            : {
                gasPrice: gasParams.gasPrice,
              }),
          gasLimit: 21000,
        }

        // Kirim transaksi
        const response = await selectedWallet.sendTransaction(tx)
        console.log(chalk.hex("#00FF00")(`✅ Transaksi pembatalan dikirim: ${response.hash}`))

        // Tunggu konfirmasi
        console.log(chalk.hex("#FFFF00")(`⏳ Menunggu konfirmasi...`))
        const receipt = await response.wait()

        if (receipt && receipt.status === 1) {
          console.log(chalk.hex("#00FF00")(`✅ Transaksi dengan nonce ${nonce} berhasil dibatalkan!`))
          successCount++

          // Kirim notifikasi Telegram
          const message =
            `🚫 Nonce ${nonce} Dibatalkan\n` +
            `👛 Wallet: ${selectedWallet.address}\n` +
            `✅ Transaksi pembatalan: ${response.hash}\n` +
            `⛽ ${
              gasParams.supportsEIP1559
                ? `Max Priority Fee: ${ethers.formatUnits(gasParams.maxPriorityFeePerGas, "gwei")} Gwei, Max Fee: ${ethers.formatUnits(gasParams.maxFeePerGas, "gwei")} Gwei`
                : `Gas Price: ${ethers.formatUnits(gasParams.gasPrice, "gwei")} Gwei`
            }\n` +
            `⏰ Waktu: ${new Date().toLocaleString()}`

          await sendTelegramMessage(message, response.hash)
        } else {
          console.log(chalk.hex("#FF3131")(`❌ Pembatalan nonce ${nonce} gagal!`))
          failCount++
        }
      } catch (error) {
        console.log(chalk.hex("#FF3131")(`❌ Error saat membatalkan nonce ${nonce}: ${error.message}`))

        // Jika error karena nonce sudah digunakan, anggap berhasil
        if (error.message.includes("nonce has already been used")) {
          console.log(chalk.hex("#00FF00")(`✅ Nonce ${nonce} sudah digunakan oleh transaksi lain.`))
          successCount++
        } else {
          failCount++
        }
      }
    }

    // Tampilkan ringkasan
    console.log(chalk.hex("#00FF00")("\n✅ Proses pembatalan nonce selesai!"))
    console.log(chalk.hex("#00FF00")(`✅ Berhasil: ${successCount}`))
    if (failCount > 0) {
      console.log(chalk.hex("#FF3131")(`❌ Gagal: ${failCount}`))
    }

    // Kirim notifikasi ringkasan ke Telegram
    const summaryMessage =
      `📊 Ringkasan Pembatalan Nonce\n` +
      `👛 Wallet: ${selectedWallet.address}\n` +
      `✅ Berhasil: ${successCount}\n` +
      `❌ Gagal: ${failCount}\n` +
      `⏰ Waktu: ${new Date().toLocaleString()}`

    await sendTelegramMessage(summaryMessage)

    // Tunggu user sebelum kembali ke menu utama
    readline.question(chalk.hex("#00FFFF")("\nTekan Enter untuk kembali ke menu utama..."))
  } catch (error) {
    logError("Cancel Nonce", error)
    console.error(chalk.hex("#FF1493")(`❌ Error: ${error.message}`))
    readline.question(chalk.hex("#00FFFF")("\nTekan Enter untuk kembali ke menu utama..."))
  }
}

async function main() {
  console.clear()
  console.log(
    chalk.hex("#00FFFF")(`
                                ,        ,
                                /(        )\`
                                \\ \\___   / |
                                /- _  \`-/  '
                               (/\\/ \\ \\   /\\
                               / /   | \`    \\
                               O O   ) /    |
                               \`-^--'\`<     '
                   TM         (_.)  _  )   /
|  | |\\  | ~|~ \\ /             \`.___/\`    /
|  | | \\ |  |   X                \`-----' /
\`__| |  \\| _|_ / \\  <----.     __ / __   \\
                    <----|====O)))==) \\) /====
                    <----'    \`--' \`.__,' \\
                                 |        |
                                  \\       /
                             ______( (_  / \\______
                           ,'  ,-----'   |        \\
                           \`--{__________)        \\/
                                      edosetiawan.eth
  `),
  )

  try {
    console.log(chalk.hex("#FF00FF")("\n╔════════════════════════════════════════════╗"))
    console.log(chalk.hex("#FF00FF")("║       MULTISENDER - ASSAM TESTNET          ║"))
    console.log(chalk.hex("#FF00FF")("╚════════════════════════════════════════════╝"))
    console.log(chalk.hex("#00FFFF")("\n╔════════════════════════════════════════════╗"))
    console.log(chalk.hex("#00FFFF")("║      AUTHOR : edosetiawan.eth              ║"))
    console.log(chalk.hex("#00FFFF")("║      E-MAIL : edosetiawan.eth@gmail.com    ║"))
    console.log(chalk.hex("#00FFFF")("║   INSTAGRAM : @edosetiawan.eth             ║"))
    console.log(chalk.hex("#00FFFF")("║   TWITTER/X : @edosetiawan_eth             ║"))
    console.log(chalk.hex("#00FFFF")("║      GITHUB : edosetiawan-xyz              ║"))
    console.log(chalk.hex("#00FFFF")("║     DISCORD : edosetiawan.eth              ║"))
    console.log(chalk.hex("#00FFFF")("╚════════════════════════════════════════════╝\n"))

    console.log(chalk.hex("#FF00FF")("╔═════════════════════════╗"))
    console.log(chalk.hex("#FF00FF")("║          MENU           ║"))
    console.log(chalk.hex("#FF00FF")("╠═════════════════════════╣"))
    console.log(chalk.hex("#00FFFF")("║ [1] Bitcoin - BTC       ║"))
    console.log(chalk.hex("#00FFFF")("║ [2] MeowTea Token - MTT ║"))
    console.log(chalk.hex("#00FFFF")("║ [3] TeaDogs INU - TDI   ║"))
    console.log(chalk.hex("#00FFFF")("║ [4] Kirim Token Manual  ║"))
    console.log(chalk.hex("#00FFFF")("║ [5] Cancel Nonce        ║"))
    console.log(chalk.hex("#FF1493")("║ [0] CANCEL              ║"))
    console.log(chalk.hex("#FF00FF")("╚═════════════════════════╝\n"))

    const tokenOptions = Object.keys(tokens)
    tokenOptions.forEach((token, index) => {
      console.log(chalk.hex("#00FFFF")(`[${index + 1}] ${token}`))
    })
    console.log(chalk.hex("#00FFFF")("[4] Kirim Token Manual"))
    console.log(chalk.hex("#00FFFF")("[5] Cancel Nonce"))
    console.log(chalk.hex("#FF1493")("[0] CANCEL"))

    while (true) {
      const input = readline.question(chalk.hex("#00FFFF")("\n➤ Pilih opsi (0-5): "))
      const choice = Number.parseInt(input)

      if (input.trim() === "0") {
        console.log(chalk.hex("#FF1493")("❌ Operasi dibatalkan oleh user."))
        process.exit(0)
      }

      let tokenSymbol, tokenAddress

      if (choice === 5) {
        // Fitur Cancel Nonce
        await cancelNonce()
        // Kembali ke menu utama setelah selesai
        main().catch((err) => {
          console.error(chalk.hex("#FF1493")(`❌ Error: ${err.message}`))
          process.exit(1)
        })
        return
      } else if (choice === 4) {
        // Kirim Token Manual
        tokenAddress = readline.question(chalk.hex("#00FFFF")("Masukkan alamat smart contract token: "))
        tokenSymbol = readline.question(chalk.hex("#00FFFF")("Masukkan simbol token: "))
      } else if (!isNaN(choice) && choice > 0 && choice <= tokenOptions.length) {
        tokenSymbol = tokenOptions[choice - 1]
        tokenAddress = tokens[tokenSymbol]
      } else {
        console.log(chalk.hex("#FF3131")("❌ Pilihan tidak valid! Silakan coba lagi."))
        continue
      }

      const fileName = selectCSVFile()
      console.log(chalk.hex("#00FFFF")(`📂 File yang dipilih: ${chalk.hex("#FF00FF")(fileName)}`))

      const filePath = path.resolve(fileName)
      if (!fs.existsSync(filePath)) {
        throw new Error("File tidak ditemukan!")
      }

      let data = fs.readFileSync(filePath, "utf8").trim().split("\n")

      if (data.length > 0 && data[0].toLowerCase().includes("quantity")) {
        console.log(chalk.hex("#FFFF00")("⚠️ Melewati baris pertama karena berisi header"))
        data = data.slice(1)
      }

      console.log(chalk.hex("#00FFFF")(`📊 Total transaksi: ${chalk.hex("#FF00FF")(data.length)}`))

      // Cek saldo $TEA dan tampilkan estimasi waktu
      const wallet = wallets[0]
      const teaBalance = await checkTeaBalance(wallet.address)
      console.log(chalk.hex("#00FFFF")(`💰 Saldo $TEA: ${teaBalance} TEA`))

      // Cek apakah jaringan mendukung EIP-1559
      const feeData = await provider.getFeeData()
      const supportsEIP1559 = !!feeData.maxFeePerGas
      console.log(chalk.hex("#00FFFF")(`🔧 Jaringan ${supportsEIP1559 ? "mendukung" : "tidak mendukung"} EIP-1559`))

      if (supportsEIP1559) {
        console.log(
          chalk.hex("#00FFFF")(
            `⛽ Base Fee: ${ethers.formatUnits(feeData.lastBaseFeePerGas || 0n, "gwei")} Gwei, ` +
              `Priority Fee: ${ethers.formatUnits(feeData.maxPriorityFeePerGas || 0n, "gwei")} Gwei`,
          ),
        )
      } else {
        console.log(chalk.hex("#00FFFF")(`⛽ Gas Price saat ini: ${ethers.formatUnits(feeData.gasPrice, "gwei")} Gwei`))
      }

      // Cek network congestion
      const congestion = await checkNetworkCongestion()
      if (congestion.congested) {
        console.log(
          chalk.hex("#FFFF00")(
            `⚠️ Jaringan sedang padat (level ${congestion.level}), transaksi mungkin membutuhkan gas lebih tinggi`,
          ),
        )
      }

      const retryCount = chooseRetryCount()
      const delayChoice = chooseTransactionDelay()
      let delayTime = 0
      let randomDelayRange = { min: 0, max: 0 }
      let batchSize = 1

      if (delayChoice === 0) {
        // Tanpa Jeda
        console.log(chalk.hex("#00FFFF")("Transaksi akan dilakukan tanpa jeda."))
        console.log(
          chalk.hex("#FFFF00")("⚠️ Direkomendasikan 1-100 batch pertransaksi. Jika melewati itu akan terjadi error."),
        )
        batchSize = chooseBatchSize()
        console.log(chalk.hex("#00FFFF")(`Batch size: ${batchSize} transaksi per batch`))
      } else if (delayChoice === 1) {
        delayTime = setManualDelay()
        console.log(chalk.hex("#00FFFF")(`ℹ️ Mode: Jeda Manual ${delayTime} detik`))
      } else if (delayChoice === 2) {
        randomDelayRange = setRandomDelayRange()
        console.log(chalk.hex("#00FFFF")(`ℹ️ Mode: Jeda Acak ${randomDelayRange.min}-${randomDelayRange.max} detik`))
      }

      // Menghitung dan menampilkan estimasi waktu total
      const totalEstimatedTime = calculateTotalEstimatedTime(
        data.length,
        delayChoice,
        delayTime,
        randomDelayRange,
        batchSize,
      )
      console.log(chalk.hex("#00FFFF")(`⏱️ Estimasi waktu total: ${totalEstimatedTime}`))

      setTelegramDelay()

      let successCount = 0
      let failCount = 0
      let reportData = "Address,Amount,Status\n"

      const totalTx = data.length

      // Memuat checkpoint
      const checkpoint = loadCheckpoint()

      // Dapatkan nonce awal
      let nonce = await getValidNonce(wallet, true)
      console.log(chalk.hex("#00FFFF")(`🔢 Nonce awal: ${nonce}`))

      // Inisialisasi daftar transaksi yang berhasil dan gagal untuk session ini
      const sessionSuccessful = new Set()
      const sessionFailed = new Set()

      for (let i = checkpoint; i < totalTx; i += batchSize) {
        const batch = data.slice(i, i + batchSize)
        const promises = batch.map(async (row, index) => {
          const [address, amount] = row.split(",").map((x) => x.trim())

          if (!ethers.isAddress(address) || isNaN(amount) || amount <= 0) {
            console.log(chalk.hex("#FF3131")(`❌ Baris ${i + index + 1} diabaikan: Format salah`))
            return
          }

          // Cek apakah transaksi sudah dilakukan dalam session ini
          if (sessionSuccessful.has(address)) {
            console.log(chalk.hex("#FFFF00")(`⚠️ Transaksi ke ${address} sudah sukses dalam session ini. Dilewati.`))
            return
          }
          if (sessionFailed.has(address)) {
            console.log(chalk.hex("#FFFF00")(`⚠️ Transaksi ke ${address} sudah gagal dalam session ini. Dilewati.`))
            return
          }

          // Dapatkan nonce baru untuk setiap transaksi
          const txNonce = nonce + index

          // Cek dan tangani transaksi yang stuck sebelum mengirim yang baru
          await checkStuckTransactions(wallet)

          const result = await sendTransactionWithRetry(
            wallet,
            tokenAddress,
            address,
            amount,
            tokenSymbol,
            i + index,
            totalTx,
            txNonce,
            retryCount,
          )

          if (result === "SUKSES") {
            successCount++
            sessionSuccessful.add(address)
            reportData += `${address},${amount},SUKSES\n`
          } else {
            failCount++
            sessionFailed.add(address)
            reportData += `${address},${amount},GAGAL\n`
          }
        })

        await Promise.all(promises)
        nonce += batch.length

        // Dapatkan nonce terbaru setelah setiap batch untuk memastikan sinkronisasi
        if (i + batchSize < totalTx) {
          nonce = await getValidNonce(wallet, true)
          console.log(chalk.hex("#00FFFF")(`🔢 Nonce terbaru: ${nonce}`))
        }

        saveCheckpoint(i + batchSize) // Simpan checkpoint setelah setiap batch
        console.log(
          chalk.hex("#00FFFF")(
            `🚀 Progress: ${chalk.hex("#FF00FF")(`${Math.min(i + batchSize, totalTx)}/${totalTx}`)} (${Math.round((Math.min(i + batchSize, totalTx) / totalTx) * 100)}%)`,
          ),
        )

        if (i < totalTx - batchSize && delayChoice !== 0) {
          await applyDelay(delayChoice, delayTime, randomDelayRange, i, totalTx)
        }

        // Update saldo $TEA setiap 10 transaksi
        if ((i + 1) % 10 === 0) {
          const updatedTeaBalance = await checkTeaBalance(wallet.address)
          console.log(chalk.hex("#00FFFF")(`💰 Saldo $TEA terbaru: ${updatedTeaBalance} TEA`))
        }

        // Tampilkan gas price terbaru dan cek network congestion setiap 5 transaksi
        if ((i + 1) % 5 === 0) {
          const feeData = await provider.getFeeData()
          if (feeData.maxFeePerGas) {
            console.log(
              chalk.hex("#00FFFF")(
                `⛽ Base Fee: ${ethers.formatUnits(feeData.lastBaseFeePerGas || 0n, "gwei")} Gwei, ` +
                  `Priority Fee: ${ethers.formatUnits(feeData.maxPriorityFeePerGas || 0n, "gwei")} Gwei`,
              ),
            )
          } else {
            console.log(
              chalk.hex("#00FFFF")(`⛽ Gas Price saat ini: ${ethers.formatUnits(feeData.gasPrice, "gwei")} Gwei`),
            )
          }

          // Cek network congestion
          const congestion = await checkNetworkCongestion()
          if (congestion.congested) {
            console.log(
              chalk.hex("#FFFF00")(
                `⚠️ Jaringan sedang padat (level ${congestion.level}), transaksi mungkin membutuhkan gas lebih tinggi`,
              ),
            )
          }
        }
      }

      console.log(chalk.hex("#00FF00")("\n✅ Semua transaksi selesai!\n"))

      const finalReport = `✅ Laporan Transaksi:\\nSukses: ${successCount}\\nGagal: ${failCount}`
      await sendTelegramMessage(finalReport)
      console.log(chalk.hex("#FF00FF")(finalReport))

      fs.writeFileSync("report.csv", reportData)
      console.log(chalk.hex("#00FFFF")("📊 Laporan telah disimpan dalam file report.csv"))
      break
    }
  } catch (error) {
    logError("Main Execution", error)
    console.error(chalk.hex("#FF1493")(`❌ Error: ${error.message}`))
  }
}

process.on("SIGINT", () => {
  console.log(chalk.hex("#FFFF00")("\n\n⚠️ Program dihentikan oleh user."))
  process.exit(0)
})

main().catch((err) => {
  console.error(chalk.hex("#FF1493")(`❌ Error: ${err.message}`))
  process.exit(1)
})

console.log(chalk.hex("#FF00FF")("✨ Script optimized token transfer has been executed."));
console.log(chalk.greenBright("✨")); // Menampilkan emoji ✨ dengan warna hijau terang
console.log(chalk.greenBright("================================================================================================"));
console.log(chalk.bold.green("        ⚠️  PERINGATAN HAK CIPTA ⚠️        "));
console.log(chalk.greenBright("================================================================================================"));
console.log(
  chalk.redBright.bold("DILARANG KERAS ") +
  chalk.redBright("menyalin, mendistribusikan, atau menggunakan kode dalamscript ini tanpa izin dari ") +
  chalk.bold.green("edosetiawan.eth") +
  chalk.redBright(" Segala bentuk duplikasi tanpa izin akan dianggap sebagai pelanggaran hak cipta")
);
console.log(chalk.greenBright("================================================================================================"));
console.log(chalk.bold.green("        ✅ PENGGUNAAN RESMI ✅        "));
console.log(chalk.greenBright("================================================================================================"));
console.log(
  chalk.yellowBright(
    "Script ini hanya boleh digunakan oleh pemilik resmi yang telah diberikan akses. Jika Anda bukan pengguna resmi, segera hubungi "
  ) +
  chalk.bold.red("edosetiawan.eth") +
  chalk.yellowBright(" untuk validasi.")
);
