package io.github.revocx35.walogger.data

import java.net.Socket
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedTrustManager
import javax.net.ssl.X509TrustManager

/**
 * TLS trust for the wa_logger server: Android's system CAs first. Self-hosted servers often use a
 * private CA (e.g. Caddy's internal CA when opened by IP address), so the owner can additionally
 * trust specific certificates — a CA file they import or a certificate they confirmed by
 * fingerprint — and only for their configured server host. Hostname verification always stays on.
 */
class ServerTrust(private val prefs: Prefs) : X509ExtendedTrustManager() {
    private val system: X509TrustManager = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        .apply { init(null as KeyStore?) }
        .trustManagers.filterIsInstance<X509TrustManager>().first()

    @Volatile var serverHost: String? = null

    @Volatile private var anchors: List<X509Certificate> = load()

    /** The chain of the last connection rejected for our server (shown to the owner for review). */
    @Volatile var lastRejected: List<X509Certificate>? = null
        private set

    val socketFactory: SSLSocketFactory = SSLContext.getInstance("TLS").apply { init(null, arrayOf(this@ServerTrust), null) }.socketFactory

    private fun load(): List<X509Certificate> = prefs.trustedCerts.mapNotNull { parseCertificate(it) }

    fun trusted(): List<X509Certificate> = anchors

    fun add(cert: X509Certificate) {
        val list = anchors.filterNot { it.encoded.contentEquals(cert.encoded) } + cert
        prefs.trustedCerts = list.map { it.encoded }
        anchors = list
    }

    fun remove(cert: X509Certificate) {
        val list = anchors.filterNot { it.encoded.contentEquals(cert.encoded) }
        prefs.trustedCerts = list.map { it.encoded }
        anchors = list
    }

    fun reload() {
        anchors = load()
        lastRejected = null
    }

    private fun check(chain: Array<X509Certificate>, authType: String, host: String?, viaSystem: () -> Unit) {
        try {
            viaSystem()
            return
        } catch (e: CertificateException) {
            if (host != null && host.equals(serverHost, ignoreCase = true)) {
                if (chainEndsInAnchor(chain)) return
                lastRejected = chain.toList()
            }
            throw e
        }
    }

    /** The chain links (signatures, validity) up to a certificate that is, or is signed by, a trusted one. */
    private fun chainEndsInAnchor(chain: Array<X509Certificate>): Boolean {
        if (chain.isEmpty()) return false
        for (anchor in anchors) {
            runCatching { anchor.checkValidity() }.getOrElse { continue }
            for (i in chain.indices) {
                val cert = chain[i]
                val isAnchor = cert.encoded.contentEquals(anchor.encoded)
                val signedByAnchor = !isAnchor && cert.issuerX500Principal == anchor.subjectX500Principal &&
                    runCatching { cert.verify(anchor.publicKey) }.isSuccess
                if (!isAnchor && !signedByAnchor) continue
                val ok = runCatching {
                    for (j in 0..i) chain[j].checkValidity()
                    for (j in 0 until i) chain[j].verify(chain[j + 1].publicKey)
                }.isSuccess
                if (ok) return true
            }
        }
        return false
    }

    private fun hostOf(socket: Socket?): String? = (socket as? SSLSocket)?.handshakeSession?.peerHost
    private fun hostOf(engine: SSLEngine?): String? = engine?.peerHost

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String, socket: Socket?) =
        check(chain, authType, hostOf(socket)) {
            if (system is X509ExtendedTrustManager) system.checkServerTrusted(chain, authType, socket) else system.checkServerTrusted(chain, authType)
        }

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String, engine: SSLEngine?) =
        check(chain, authType, hostOf(engine)) {
            if (system is X509ExtendedTrustManager) system.checkServerTrusted(chain, authType, engine) else system.checkServerTrusted(chain, authType)
        }

    override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) =
        check(chain, authType, null) { system.checkServerTrusted(chain, authType) }

    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String, socket: Socket?) = throw CertificateException("no client certs")
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String, engine: SSLEngine?) = throw CertificateException("no client certs")
    override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = throw CertificateException("no client certs")
    override fun getAcceptedIssuers(): Array<X509Certificate> = system.acceptedIssuers + anchors

    companion object {
        fun parseCertificate(bytes: ByteArray): X509Certificate? = runCatching {
            CertificateFactory.getInstance("X.509").generateCertificate(bytes.inputStream()) as X509Certificate
        }.getOrNull()

        fun sha256(cert: X509Certificate): String =
            MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString(":") { "%02X".format(it) }

        fun commonName(cert: X509Certificate): String {
            val dn = cert.subjectX500Principal.name
            return Regex("(?:^|,)CN=([^,]*)").find(dn)?.groupValues?.get(1) ?: dn
        }
    }
}
