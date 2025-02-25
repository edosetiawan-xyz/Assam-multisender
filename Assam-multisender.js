import fs from "fs"
import path from "path"
import readline from "readline-sync"
import chalk from "chalk"
import { ethers } from "ethers"
import dotenv from "dotenv"
import { createWriteStream } from "fs"

dotenv.config()

// Setup error logging
const errorLogStream = createWriteStream("error_log.txt", { flags: "a" })

// Konfigurasi provider dan wallet
const RPC_URLS = process.env.RPC_URLS ? process.env.RPC_URLS.split(",") : [process.env.RPC_URL]
let currentRpcIndex = 0

function logError(context, error, additionalInfo = {}) {
  const timestamp = new Date().toISOString()
  const errorLog = {
    timestamp,
    context,
    error: {
      message: error.message,
      stack: error.stack,
      code: error.code,
    },
    additionalInfo,
  }

  errorLogStream.write(`${JSON.stringify(errorLog, null, 2)}\n---\n`)
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

async function sendTransactionWithRetry(
  wallet,
  tokenAddress,
  recipient,
  amount,
  tokenSymbol,
  currentIndex,
  totalTx,
  nonce,
  maxRetries = 5,
) {
  let retries = 0
  const delay = 1000

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

      const tx = await tokenContract.transfer(recipient, amountInWei, {
        nonce,
        gasLimit: 100000,
      })

      console.log(chalk.hex("#00FF00")(`✅ Transaksi dikirim: ${tx.hash}`))

      const currentGwei = await provider.getFeeData()
      const estimatedTime = await estimateTransactionTime(currentGwei.gasPrice)

      const timestamp = new Date()
      const formattedTimestamp = `${timestamp.getDate()} ${timestamp.toLocaleString('default', { month: 'long' })} ${timestamp.getFullYear()} ${timestamp.getHours()}:${timestamp.getMinutes()}:${timestamp.getSeconds()}`

      const message = `🚀 Mengirim ${amount} ${tokenSymbol} ke ${recipient}\n` +
        `• felicia (${currentIndex + 1}/${totalTx}) edosetiawan.eth\n` +
        `✅ Transaksi dikirim: ${tx.hash}\n` +
        `⏱️ Estimasi waktu: ${estimatedTime}\n` +
        `⛽ Gas Price: ${ethers.formatUnits(currentGwei.gasPrice, "gwei")} Gwei\n` +
        `⏰ Waktu transaksi: ${formattedTimestamp}`

      await sendTelegramMessage(message, tx.hash)
      console.log(chalk.hex("#00FFFF")(message))

      const receipt = await tx.wait()
      return "SUKSES"
    } catch (error) {
      logError("Transaction", error, {
        attempt: retries + 1,
        recipient,
        amount,
        tokenSymbol,
        nonce,
      })

      if (error.message.includes("insufficient funds")) {
        console.log(chalk.hex("#FF3131")("❌ Dana tidak mencukupi! Membatalkan transaksi."))
        return "GAGAL"
      }

      retries++
      if (retries < maxRetries) {
        const waitTime = Math.min(delay * Math.pow(2, retries), 30000)
        console.log(chalk.hex("#FFFF00")(`⏳ Menunggu ${waitTime / 1000} detik sebelum mencoba lagi...`))
        await new Promise((resolve) => setTimeout(resolve, waitTime))
      }
    }
  }
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

function loadPreviousReports() {
  const successfulTransactions = new Set()
  const failedTransactions = new Set()

  if (fs.existsSync("Laporan transaksi sukses.txt")) {
    const successData = fs.readFileSync("Laporan transaksi sukses.txt", "utf8").trim().split("\n")
    successData.slice(1).forEach((line) => {
      const [address] = line.split(",")
      successfulTransactions.add(address)
    })
  }

  if (fs.existsSync("Laporan Transaksi gagal.txt")) {
    const failData = fs.readFileSync("Laporan Transaksi gagal.txt", "utf8").trim().split("\n")
    failData.slice(1).forEach((line) => {
      const [address] = line.split(",")
      failedTransactions.add(address)
    })
  }

  return { successfulTransactions, failedTransactions }
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

function saveSuccessfulTransaction(address, amount) {
  fs.appendFileSync("Laporan transaksi sukses.txt", `${address},${amount},SUKSES\n`)
}

function saveFailedTransaction(address, amount) {
  fs.appendFileSync("Laporan Transaksi gagal.txt", `${address},${amount},GAGAL\n`)
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
    console.log(chalk.hex("#FF1493")("║ [0] CANCEL              ║"))
    console.log(chalk.hex("#FF00FF")("╚═════════════════════════╝\n"))

    const tokenOptions = Object.keys(tokens)
    tokenOptions.forEach((token, index) => {
      console.log(chalk.hex("#00FFFF")(`[${index + 1}] ${token}`))
    })
    console.log(chalk.hex("#00FFFF")("[4] Kirim Token Manual"))
    console.log(chalk.hex("#FF1493")("[0] CANCEL"))

    while (true) {
      const input = readline.question(chalk.hex("#00FFFF")("\n➤ Pilih opsi (0-4): "))
      const choice = Number.parseInt(input)

      if (input.trim() === "0") {
        console.log(chalk.hex("#FF1493")("❌ Operasi dibatalkan oleh user."))
        process.exit(0)
      }

      let tokenSymbol, tokenAddress

      if (choice === 4) {
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

      const currentGwei = await provider.getFeeData()
      console.log(
        chalk.hex("#00FFFF")(`⛽ Gas Price saat ini: ${ethers.formatUnits(currentGwei.gasPrice, "gwei")} Gwei`),
      )

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
      let nonce = await provider.getTransactionCount(wallet.address)

      // Memuat laporan transaksi sebelumnya
      const { successfulTransactions, failedTransactions } = loadPreviousReports()
      const checkpoint = loadCheckpoint()

      for (let i = checkpoint; i < totalTx; i += batchSize) {
        const batch = data.slice(i, i + batchSize)
        const promises = batch.map(async (row, index) => {
          const [address, amount] = row.split(",").map((x) => x.trim())

          if (!ethers.isAddress(address) || isNaN(amount) || amount <= 0) {
            console.log(chalk.hex("#FF3131")(`❌ Baris ${i + index + 1} diabaikan: Format salah`))
            return
          }

          // Cek apakah transaksi sudah dilakukan sebelumnya
          if (successfulTransactions.has(address)) {
            console.log(chalk.hex("#FFFF00")(`⚠️ Transaksi ke ${address} sudah sukses sebelumnya. Dilewati.`))
            return
          }
          if (failedTransactions.has(address)) {
            console.log(chalk.hex("#FFFF00")(`⚠️ Transaksi ke ${address} sudah gagal sebelumnya. Dilewati.`))
            return
          }

          const result = await sendTransactionWithRetry(
            wallet,
            tokenAddress,
            address,
            amount,
            tokenSymbol,
            i + index,
            totalTx,
            nonce + index,
            retryCount,
          )

          if (result === "SUKSES") {
            successCount++
            saveSuccessfulTransaction(address, amount)
            reportData += `${address},${amount},SUKSES\n`
          } else {
            failCount++
            saveFailedTransaction(address, amount)
            reportData += `${address},${amount},GAGAL\n`
          }
        })

        await Promise.all(promises)
        nonce += batch.length
        saveCheckpoint(i + batchSize) // Simpan checkpoint setelah setiap batch
        console.log(
          chalk.hex("#00FFFF")(
            `🚀 Progress: ${chalk.hex("#FF00FF")(`${i + 1}/${totalTx}`)} (${Math.round(((i + 1) / totalTx) * 100)}%)`,
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

        // Tampilkan gas price terbaru setiap 5 transaksi
        if ((i + 1) % 5 === 0) {
          const currentGwei = await provider.getFeeData()
          console.log(
            chalk.hex("#00FFFF")(`⛽ Gas Price saat ini: ${ethers.formatUnits(currentGwei.gasPrice, "gwei")} Gwei`),
          )
        }
      }

      console.log(chalk.hex("#00FF00")("\n✅ Semua transaksi selesai!\n"))

      const finalReport = `✅ Laporan Transaksi:\nSukses: ${successCount}\nGagal: ${failCount}`
      await sendTelegramMessage(finalReport)
      console.log(chalk.hex("#FF00FF")(finalReport))

      fs.writeFileSync("report.csv", reportData)
      console.log(chalk.hex("#00FFFF")("📊 Laporan telah disimpan dalam file report.csv"))
      break
    }
  } catch (error) {
    logError("Main Execution", error)
    console.error(chalk.hex("#FF1493")(`❌ Error: ${error.message}`))
  } finally {
    errorLogStream.end()
  }
}

process.on("SIGINT", () => {
  console.log(chalk.hex("#FFFF00")("\n\n⚠️ Program dihentikan oleh user."))
  errorLogStream.end()
  process.exit(0)
})

main().catch((err) => {
  console.error(chalk.hex("#FF1493")(`❌ Error: ${err.message}`))
  errorLogStream.end()
  process.exit(1)
})

console.log(chalk.hex("#FF00FF")("✨ Script optimized token transfer has been executed."))
console.log(chalk.greenBright("✨")) // Menampilkan emoji ✨ dengan warna hijau terang
console.log(chalk.greenBright("=========================================="))
console.log(chalk.bold.green("        ⚠️  PERINGATAN HAK CIPTA ⚠️        "))
console.log(chalk.greenBright("=========================================="))
console.log(
  chalk.redBright.bold("DILARANG KERAS ") +
    chalk.redBright("menyalin, mendistribusikan, atau menggunakan kode dalam script ini tanpa izin dari ") +
    chalk.bold.green("edosetiawan.eth") +
    chalk.redBright(". Segala bentuk duplikasi tanpa izin akan dianggap sebagai pelanggaran hak cipta."),
)

console.log("\n" + chalk.greenBright("=========================================="))
console.log(chalk.bold.green("        ✅ PENGGUNAAN RESMI ✅        "))
console.log(chalk.greenBright("=========================================="))
console.log(
  chalk.yellowBright(
    "Script ini hanya boleh digunakan oleh pemilik resmi yang telah diberikan akses. Jika Anda mendapatkan script ini dari sumber tidak resmi, harap segera menghubungi ",
  ) +
    chalk.bold.red("edosetiawan.eth") +
    chalk.yellowBright(" untuk validasi."),
)


