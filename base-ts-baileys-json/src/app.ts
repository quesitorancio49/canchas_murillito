import { join } from 'path'
import { createBot, createProvider, createFlow, addKeyword, utils, EVENTS } from '@builderbot/bot'
import { JsonFileDB as Database } from '@builderbot/database-json'
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
import { google } from 'googleapis'
import { DateTime } from 'luxon'
import cron from 'node-cron'

// --- CONFIGURACIÓN GOOGLE SHEETS ---
const SPREADSHEET_ID = 'TU_ID_DE_GOOGLE_SHEET' // Reemplaza con tu ID
const KEY_PATH = join(process.cwd(), 'credentials.json')

/**
 * Cliente de Google Sheets
 */
async function getSheetsClient() {
    const auth = new google.auth.GoogleAuth({
        keyFile: KEY_PATH,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
    return google.sheets({ version: 'v4', auth })
}

/**
 * CRON JOB: Se ejecuta cada 5 minutos para liberar canchas vencidas
 */
cron.schedule('*/5 * * * *', async () => {
    console.log('Verificando reservas expiradas...')
    const sheets = await getSheetsClient()
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Hoja1!A2:F100',
    })
    const rows = response.data.values || []
    const now = DateTime.now().toMillis()

    for (let i = 0; i < rows.length; i++) {
        const [fecha, hora, cancha, estado, nombre, expiracion] = rows[i]
        
        if (estado === 'Pendiente' && expiracion) {
            if (now > parseInt(expiracion)) {
                const rowIndex = i + 2
                await sheets.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `Hoja1!D${rowIndex}:F${rowIndex}`,
                    valueInputOption: 'RAW',
                    requestBody: { values: [['Disponible', '', '']] },
                })
                console.log(`Cancha ${cancha} liberada (Reserva de ${nombre} expiró)`)
            }
        }
    }
})

// --- FLUJOS DEL BOT ---

/**
 * Flujo 3: Confirmación y recordatorio de pago
 */
const flowConfirmacion = addKeyword(EVENTS.ACTION)
    .addAnswer([
        '✅ ¡Reserva pre-agendada!',
        'Tienes *2 horas* para realizar el abono y enviar el comprobante por este medio.',
        'De lo contrario, el sistema liberará la cancha automáticamente.',
        '\nCuentas para transferencia:',
        '🏦 Banco Ejemplo: 123-456-789',
        '💰 Valor abono: $20.000'
    ])

/**
 * Flujo 2: Selección de cancha y horario
 */
const flowReserva = addKeyword(EVENTS.ACTION)
    .addAnswer('Consultando disponibilidad para hoy...', null, async (ctx, { flowDynamic }) => {
        const sheets = await getSheetsClient()
        const res = await sheets.spreadsheets.values.get({ 
            spreadsheetId: SPREADSHEET_ID, 
            range: 'Hoja1!A2:D100' 
        })
        
        const disponibles = res.data.values?.filter(r => r[3] === 'Disponible') || []

        if (disponibles.length === 0) {
            return await flowDynamic('❌ Lo siento, no hay canchas disponibles por el momento.')
        }

        let menu = 'Selecciona el horario (escribe el número):\n\n'
        disponibles.forEach((r, i) => {
            menu += `*${i + 1}*. ${r[1]} - ${r[2]}\n`
        })
        await flowDynamic(menu)
    })
    .addAnswer(
        'Escribe el número de la opción:',
        { capture: true },
        async (ctx, { state, fallBack, flowDynamic, gotoFlow }) => {
            const indice = parseInt(ctx.body) - 1
            const sheets = await getSheetsClient()
            const res = await sheets.spreadsheets.values.get({ 
                spreadsheetId: SPREADSHEET_ID, 
                range: 'Hoja1!A2:D100' 
            })
            
            const disponibles = res.data.values?.filter(r => r[3] === 'Disponible') || []

            if (!disponibles[indice]) return fallBack('⚠️ Opción no válida, intenta de nuevo.')

            const seleccion = disponibles[indice]
            const nombreUsuario = state.get('name')
            
            // Calcular fila exacta en el Excel (buscando por hora y cancha)
            const allRows = res.data.values || []
            const realIndex = allRows.findIndex(r => r[1] === seleccion[1] && r[2] === seleccion[2]) + 2
            
            // Timestamp de expiración (Ahora + 2 horas)
            const expTime = DateTime.now().plus({ hours: 2 }).toMillis().toString()

            // Actualizar Sheet a "Pendiente"
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `Hoja1!D${realIndex}:F${realIndex}`,
                valueInputOption: 'RAW',
                requestBody: { values: [['Pendiente', nombreUsuario, expTime]] },
            })

            await flowDynamic(`Perfecto ${nombreUsuario}, has apartado la *${seleccion[2]}* a las *${seleccion[1]}*.`)
            return gotoFlow(flowConfirmacion)
        }
    )

/**
 * Flujo 1: Bienvenida y captura de nombre (Cualquier mensaje)
 */
const flowPrincipal = addKeyword(EVENTS.WELCOME)
    .addAnswer('⚽ ¡Hola! Bienvenido al sistema de reservas.')
    .addAnswer('Para empezar, ¿cuál es tu nombre?', { capture: true }, async (ctx, { state }) => {
        await state.update({ name: ctx.body })
    })
    .addAnswer('Mucho gusto. ¿Deseas ver los horarios disponibles para agendar?', { capture: true }, 
    async (ctx, { gotoFlow, flowDynamic }) => {
        const respuesta = ctx.body.toLowerCase()
        if (respuesta.includes('si') || respuesta.includes('ver') || respuesta.includes('agendar')) {
            return gotoFlow(flowReserva)
        } else {
            await flowDynamic('Entendido. Si necesitas agendar más tarde, solo escribe "Hola".')
        }
    })

// --- INICIALIZACIÓN ---
const main = async () => {
    const adapterDB = new Database({ filename: 'db.json' })
    const adapterFlow = createFlow([flowPrincipal, flowReserva, flowConfirmacion])
    const adapterProvider = createProvider(Provider)

    createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })
}

main()