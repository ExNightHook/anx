#pragma once
// ============================================================
//  MPHClient.h — Enhanced API Client для Anxiety (aesthesia.xyz)
//
//  Совместимость:
//    - Legacy mode: XOR-транспорт (как старый клиент)
//    - Enhanced mode: XOR + AES-256-GCM + HMAC-SHA256 + сессии
//
//  Протокол запроса (enhanced):
//    [4B magic: "ANX1"][8B timestamp][8B nonce][32B hmac]
//    [remaining: XOR(AES-GCM(JSON payload))]
//
//  Либо (legacy):
//    [XOR(JSON payload)]
// ============================================================

#include <windows.h>
#include <winhttp.h>
#include <string>
#include <vector>
#include <sstream>
#include <iomanip>
#include <algorithm>
#include <random>
#include <chrono>
#include "../dependencies/nlohmann/json.hpp"

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "bcrypt.lib")

using json = nlohmann::json;

namespace AnxietyAPI {

    // --- XOR ключи (должны совпадать с сервером) ---
    static constexpr uint8_t ENCRYPTION_KEYS[] = {
        0x5A, 0x5A, 0x5A, 0x7C, 0x0A, 0x7C, 0x0A, 0x3A
    };
    static constexpr size_t KEY_COUNT = sizeof(ENCRYPTION_KEYS) / sizeof(ENCRYPTION_KEYS[0]);

    // --- Magic bytes для enhanced mode ---
    static constexpr const char* MAGIC = "ANX1";

    // --- Shared secret для HMAC + AES key derivation ---
    // ВАЖНО: замените на ваш API_SHARED_SECRET из .env
    // Это hex-строка, которая конвертируется в байты
    static constexpr const char* API_SHARED_SECRET = "CHANGE_ME_IN_PRODUCTION";

    static constexpr const char* CLIENT_VERSION = "0.08";

    // ============================================================
    //  Структуры
    // ============================================================

    struct SubscriptionInfo {
        std::string type;
        std::string status;
        std::string expiryDate;
        std::string currentDate;
    };

    struct AuthResponse {
        bool success = false;
        std::string error;
        std::string sessionId;
        std::string userId;
        std::string username;
        SubscriptionInfo subscription;
    };

    struct BuildInfo {
        bool success = false;
        std::string error;
        std::string buildId;
        std::string buildHash;
    };

    // ============================================================
    //  Utility: hex encode/decode
    // ============================================================

    static std::string BytesToHex(const uint8_t* data, size_t len) {
        std::ostringstream oss;
        for (size_t i = 0; i < len; i++) {
            oss << std::hex << std::setw(2) << std::setfill('0') << (int)data[i];
        }
        return oss.str();
    }

    static std::string StringToHex(const std::string& str) {
        return BytesToHex(reinterpret_cast<const uint8_t*>(str.c_str()), str.size());
    }

    static std::vector<uint8_t> HexToBytes(const std::string& hex) {
        std::vector<uint8_t> bytes;
        for (size_t i = 0; i < hex.length(); i += 2) {
            uint8_t byte = static_cast<uint8_t>(std::stoul(hex.substr(i, 2), nullptr, 16));
            bytes.push_back(byte);
        }
        return bytes;
    }

    // ============================================================
    //  Utility: SHA-256 (via BCrypt)
    // ============================================================

    static std::vector<uint8_t> SHA256(const uint8_t* data, size_t len) {
        std::vector<uint8_t> hash(32);
        BCRYPT_ALG_HANDLE hAlg = NULL;
        BCRYPT_HASH_HANDLE hHash = NULL;
        DWORD hashLen = 0, hashObjLen = 0;

        BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_SHA256_ALGORITHM, NULL, BCRYPT_HASH_REUSABLE_FLAG);
        BCryptGetProperty(hAlg, BCRYPT_HASH_LENGTH, (PBYTE)&hashLen, sizeof(DWORD), &hashObjLen, 0);
        BCryptCreateHash(hAlg, &hHash, NULL, 0);
        BCryptHashData(hHash, (PBYTE)data, (ULONG)len, 0);
        BCryptFinishHash(hHash, hash.data(), hashLen, 0);

        BCryptDestroyHash(hHash);
        BCryptCloseAlgorithmProvider(hAlg, 0);
        return hash;
    }

    static std::vector<uint8_t> SHA256(const std::string& str) {
        return SHA256(reinterpret_cast<const uint8_t*>(str.c_str()), str.size());
    }

    // ============================================================
    //  Utility: HMAC-SHA256
    // ============================================================

    static std::vector<uint8_t> HMAC_SHA256(const uint8_t* key, size_t keyLen,
                                             const uint8_t* data, size_t dataLen) {
        std::vector<uint8_t> hash(32);
        BCRYPT_ALG_HANDLE hAlg = NULL;
        BCRYPT_HASH_HANDLE hHash = NULL;
        DWORD hashLen = 0, hashObjLen = 0;

        BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_SHA256_ALGORITHM, NULL, BCRYPT_ALG_HANDLE_HMAC_FLAG);
        BCryptGetProperty(hAlg, BCRYPT_HASH_LENGTH, (PBYTE)&hashLen, sizeof(DWORD), &hashObjLen, 0);
        BCryptCreateHash(hAlg, &hHash, NULL, 0);
        BCryptHashData(hHash, (PBYTE)key, (ULONG)keyLen, 0);
        BCryptHashData(hHash, (PBYTE)data, (ULONG)dataLen, 0);
        BCryptFinishHash(hHash, hash.data(), hashLen, 0);

        BCryptDestroyHash(hHash);
        BCryptCloseAlgorithmProvider(hAlg, 0);
        return hash;
    }

    // ============================================================
    //  Utility: AES-256-GCM encryption (via BCrypt)
    // ============================================================

    static std::vector<uint8_t> AES256GCM_Encrypt(const std::string& plaintext) {
        // Derive key from shared secret via SHA-256
        auto keyBytes = SHA256(
            reinterpret_cast<const uint8_t*>(API_SHARED_SECRET),
            strlen(API_SHARED_SECRET)
        );

        BCRYPT_ALG_HANDLE hAlg = NULL;
        BCRYPT_KEY_HANDLE hKey = NULL;
        BCRYPT_HASH_HANDLE hHash = NULL;

        std::vector<uint8_t> iv(12);
        // Random IV
        {
            HCRYPTPROV hProv = 0;
            CryptAcquireContextW(&hProv, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT);
            CryptGenRandom(hProv, (DWORD)iv.size(), iv.data());
            CryptReleaseContext(hProv, 0);
        }

        BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_AES_ALGORITHM, NULL, BCRYPT_CHAINING_MODE_GCM);
        DWORD keyObjLen = 0, ivLen = 0, tagLen = 0;
        BCryptGetProperty(hAlg, BCRYPT_OBJECT_LENGTH, (PBYTE)&keyObjLen, sizeof(DWORD), &ivLen, 0);
        BCryptGetProperty(hAlg, BCRYPT_AUTH_TAG_LENGTH, (PBYTE)&tagLen, sizeof(DWORD), &ivLen, 0);

        // Set IV length
        BCryptSetProperty(hAlg, BCRYPT_AUTH_TAG_LENGTH, (PBYTE)&tagLen, sizeof(DWORD));

        std::vector<uint8_t> keyObj(keyObjLen);
        BCryptGenerateSymmetricKey(hAlg, &hKey, keyObj.data(), keyObj.size(),
            (PBYTE)keyBytes.data(), (ULONG)keyBytes.size(), 0);

        BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO authInfo;
        BCRYPT_INIT_AUTH_MODE_INFO(authInfo);
        authInfo.pbNonce = iv.data();
        authInfo.cbNonce = (ULONG)iv.size();
        authInfo.pbTag = NULL; // allocate after
        authInfo.cbTag = tagLen;

        // Get ciphertext length
        DWORD ctLen = 0;
        BCryptEncrypt(hKey, (PBYTE)plaintext.c_str(), (ULONG)plaintext.size(),
            &authInfo, NULL, 0, NULL, 0, BCRYPT_BLOCK_PADDING, &ctLen);

        std::vector<uint8_t> ciphertext(ctLen);
        authInfo.pbTag = ciphertext.data() + ctLen - tagLen; // tag is appended

        BCryptEncrypt(hKey, (PBYTE)plaintext.c_str(), (ULONG)plaintext.size(),
            &authInfo, NULL, 0, ciphertext.data(), ctLen, 0, &ctLen);

        // Result: IV(12) + ciphertext + tag(16)
        std::vector<uint8_t> result(iv.size() + ctLen);
        memcpy(result.data(), iv.data(), iv.size());
        memcpy(result.data() + iv.size(), ciphertext.data(), ctLen);

        BCryptDestroyKey(hKey);
        BCryptCloseAlgorithmProvider(hAlg, 0);
        return result;
    }

    // ============================================================
    //  Utility: Random nonce
    // ============================================================

    static std::string GenerateNonce() {
        std::random_device rd;
        std::mt19937 gen(rd());
        std::uniform_int_distribution<> dis(0, 15);
        std::string nonce;
        for (int i = 0; i < 16; i++) {
            nonce += "0123456789abcdef"[dis(gen)];
        }
        return nonce;
    }

    // ============================================================
    //  AnxietyClient
    // ============================================================

    class AnxietyClient {
    private:
        std::string base_url;
        std::string hwid_cache;
        std::string session_id;
        bool useEnhanced = true;

        // --- XOR ---
        std::vector<uint8_t> XOREncrypt(const std::string& input) {
            std::vector<uint8_t> result(input.size());
            for (size_t i = 0; i < input.size(); ++i) {
                result[i] = static_cast<uint8_t>(input[i]) ^ ENCRYPTION_KEYS[i % KEY_COUNT];
            }
            return result;
        }

        std::vector<uint8_t> XORDecrypt(const std::vector<uint8_t>& encrypted) {
            std::vector<uint8_t> result(encrypted.size());
            for (size_t i = 0; i < encrypted.size(); ++i) {
                result[i] = encrypted[i] ^ ENCRYPTION_KEYS[i % KEY_COUNT];
            }
            return result;
        }

        // --- Enhanced payload builder ---
        std::vector<uint8_t> BuildEnhancedPayload(const std::string& jsonPayload) {
            // 1. AES-GCM encrypt the JSON
            auto aesEncrypted = AES256GCM_Encrypt(jsonPayload);
            auto payloadHex = BytesToHex(aesEncrypted.data(), aesEncrypted.size());

            // 2. Compute timestamp and nonce
            auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
            std::string timestamp = std::to_string(now);
            std::string nonce = GenerateNonce();

            // 3. Compute HMAC
            std::string hmacInput = timestamp + ":" + nonce + ":" + payloadHex;
            auto secretBytes = HexToBytes(API_SHARED_SECRET);
            auto hmac = HMAC_SHA256(secretBytes.data(), secretBytes.size(),
                reinterpret_cast<const uint8_t*>(hmacInput.c_str()), hmacInput.size());
            std::string hmacHex = BytesToHex(hmac.data(), hmac.size());

            // 4. Build packet: [4B magic][8B timestamp][8B nonce][32B hmac][payload hex bytes as raw]
            //    Отправляем как binary: magic + timestamp + nonce + hmac_hex(64) + XOR(aes_encrypted)
            std::string hmacField = hmacHex;
            // Pad/truncate timestamp to 8 chars
            while (timestamp.size() < 8) timestamp = "0" + timestamp;
            if (timestamp.size() > 8) timestamp = timestamp.substr(timestamp.size() - 8);
            // Pad/truncate nonce to 8 chars
            while (nonce.size() < 8) nonce = "0" + nonce;
            if (nonce.size() > 8) nonce = nonce.substr(0, 8);
            // Pad/truncate hmac to 32 chars
            while (hmacField.size() < 32) hmacField = "0" + hmacField;
            if (hmacField.size() > 32) hmacField = hmacField.substr(0, 32);

            std::vector<uint8_t> packet;
            // Magic "ANX1"
            packet.insert(packet.end(), MAGIC, MAGIC + 4);
            // Timestamp (8 bytes ASCII)
            packet.insert(packet.end(), timestamp.begin(), timestamp.end());
            // Nonce (8 bytes ASCII)
            packet.insert(packet.end(), nonce.begin(), nonce.end());
            // HMAC (32 bytes ASCII)
            packet.insert(packet.end(), hmacField.begin(), hmacField.end());
            // XOR over AES encrypted payload
            auto xored = XOREncrypt_vec(aesEncrypted);
            packet.insert(packet.end(), xored.begin(), xored.end());

            return packet;
        }

        // XOR for vector<uint8_t>
        std::vector<uint8_t> XOREncrypt_vec(const std::vector<uint8_t>& input) {
            std::vector<uint8_t> result(input.size());
            for (size_t i = 0; i < input.size(); ++i) {
                result[i] = input[i] ^ ENCRYPTION_KEYS[i % KEY_COUNT];
            }
            return result;
        }

        // --- String <-> WString ---
        std::wstring StringToWString(const std::string& str) {
            if (str.empty()) return std::wstring();
            int size_needed = MultiByteToWideChar(CP_UTF8, 0, str.c_str(),
                static_cast<int>(str.size()), NULL, 0);
            std::wstring wstrTo(size_needed, 0);
            MultiByteToWideChar(CP_UTF8, 0, str.c_str(),
                static_cast<int>(str.size()), &wstrTo[0], size_needed);
            return wstrTo;
        }

        // --- HTTP Request ---
        std::string HTTPRequest(const std::string& endpoint, const json& body, bool useSession = false) {
            std::string result;
            std::string fullUrl = base_url + endpoint;

            json sendBody = body;
            if (useSession && !session_id.empty()) {
                sendBody["session_id"] = session_id;
            }

            std::string jsonBody = sendBody.dump();

            std::vector<uint8_t> packetBytes;
            if (useEnhanced) {
                packetBytes = BuildEnhancedPayload(jsonBody);
            } else {
                auto xored = XOREncrypt(jsonBody);
                packetBytes = std::vector<uint8_t>(xored.begin(), xored.end());
            }

            // Parse URL
            URL_COMPONENTS urlComp = { 0 };
            urlComp.dwStructSize = sizeof(urlComp);
            urlComp.dwSchemeLength = (DWORD)-1;
            urlComp.dwHostNameLength = (DWORD)-1;
            urlComp.dwUrlPathLength = (DWORD)-1;

            std::wstring wideUrl = StringToWString(fullUrl);
            if (!WinHttpCrackUrl(wideUrl.c_str(), wideUrl.length(), 0, &urlComp)) {
                return "";
            }

            std::wstring host(urlComp.lpszHostName, urlComp.dwHostNameLength);
            std::wstring path(urlComp.lpszUrlPath, urlComp.dwUrlPathLength);

            // Determine port from scheme
            INTERNET_PORT port = (urlComp.nScheme == INTERNET_SCHEME_HTTPS)
                ? INTERNET_DEFAULT_HTTPS_PORT
                : INTERNET_DEFAULT_HTTP_PORT;

            HINTERNET hSession = WinHttpOpen(L"AnxietyClient/2.0",
                WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
                WINHTTP_NO_PROXY_BYPASS, 0);
            if (!hSession) return "";

            WinHttpSetTimeouts(hSession, 10000, 10000, 10000, 10000);

            HINTERNET hConnect = WinHttpConnect(hSession, host.c_str(), port, 0);
            if (!hConnect) { WinHttpCloseHandle(hSession); return ""; }

            DWORD flags = (urlComp.nScheme == INTERNET_SCHEME_HTTPS)
                ? WINHTTP_FLAG_SECURE : 0;

            HINTERNET hRequest = WinHttpOpenRequest(hConnect,
                L"POST", path.c_str(), NULL, WINHTTP_NO_REFERER,
                WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
            if (!hRequest) {
                WinHttpCloseHandle(hConnect);
                WinHttpCloseHandle(hSession);
                return "";
            }

            std::wstring headers = L"Content-Type: application/octet-stream\r\n"
                L"Accept: application/octet-stream\r\n"
                L"User-Agent: AnxietyClient/2.0\r\n"
                L"Connection: close\r\n";
            WinHttpAddRequestHeaders(hRequest, headers.c_str(),
                (DWORD)headers.length(), WINHTTP_ADDREQ_FLAG_ADD);

            DWORD bodyLength = static_cast<DWORD>(packetBytes.size());
            BOOL bResults = WinHttpSendRequest(hRequest,
                WINHTTP_NO_ADDITIONAL_HEADERS, 0,
                bodyLength > 0 ? packetBytes.data() : WINHTTP_NO_REQUEST_DATA,
                bodyLength, bodyLength, 0);

            if (!bResults) {
                WinHttpCloseHandle(hRequest);
                WinHttpCloseHandle(hConnect);
                WinHttpCloseHandle(hSession);
                return "";
            }

            bResults = WinHttpReceiveResponse(hRequest, NULL);
            if (!bResults) {
                WinHttpCloseHandle(hRequest);
                WinHttpCloseHandle(hConnect);
                WinHttpCloseHandle(hSession);
                return "";
            }

            // Read response
            DWORD dwSize = 0, dwDownloaded = 0;
            std::vector<uint8_t> responseBuffer;

            do {
                dwSize = 0;
                if (!WinHttpQueryDataAvailable(hRequest, &dwSize) || dwSize == 0) break;
                std::vector<uint8_t> chunk(dwSize);
                if (WinHttpReadData(hRequest, chunk.data(), dwSize, &dwDownloaded) && dwDownloaded > 0) {
                    responseBuffer.insert(responseBuffer.end(), chunk.begin(), chunk.begin() + dwDownloaded);
                } else break;
            } while (dwSize > 0);

            // Decrypt response: XOR first, then if enhanced -> AES-GCM
            if (!responseBuffer.empty()) {
                auto xored = XORDecrypt(responseBuffer);

                if (useEnhanced && xored.size() > 28) {
                    // Try enhanced: IV(12) + ciphertext + tag(16)
                    // XOR decrypt gives us AES-GCM encrypted data
                    auto aesKey = SHA256(reinterpret_cast<const uint8_t*>(API_SHARED_SECRET), strlen(API_SHARED_SECRET));

                    BCRYPT_ALG_HANDLE hAlg = NULL;
                    BCRYPT_KEY_HANDLE hKey = NULL;

                    BCryptOpenAlgorithmProvider(&hAlg, BCRYPT_AES_ALGORITHM, NULL, BCRYPT_CHAINING_MODE_GCM);

                    DWORD keyObjLen = 0;
                    BCryptGetProperty(hAlg, BCRYPT_OBJECT_LENGTH, (PBYTE)&keyObjLen, sizeof(DWORD), &dwSize, 0);

                    std::vector<uint8_t> keyObj(keyObjLen);
                    BCryptGenerateSymmetricKey(hAlg, &hKey, keyObj.data(), keyObj.size(),
                        aesKey.data(), (ULONG)aesKey.size(), 0);

                    const uint8_t* data = xored.data();
                    size_t dataLen = xored.size();

                    const uint8_t* iv = data;
                    size_t ivLen = 12;
                    const uint8_t* tag = data + dataLen - 16;
                    const uint8_t* ct = data + 12;
                    size_t ctLen = dataLen - 12 - 16;

                    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO authInfo;
                    BCRYPT_INIT_AUTH_MODE_INFO(authInfo);
                    authInfo.pbNonce = (PBYTE)iv;
                    authInfo.cbNonce = (ULONG)ivLen;
                    authInfo.pbTag = (PBYTE)tag;
                    authInfo.cbTag = 16;

                    DWORD ptLen = 0;
                    BCryptDecrypt(hKey, (PBYTE)ct, (ULONG)ctLen,
                        &authInfo, NULL, 0, NULL, 0, 0, &ptLen);

                    if (ptLen > 0) {
                        std::vector<uint8_t> plaintext(ptLen);
                        NTSTATUS status = BCryptDecrypt(hKey, (PBYTE)ct, (ULONG)ctLen,
                            &authInfo, NULL, 0, plaintext.data(), ptLen, 0, &ptLen);
                        if (NT_SUCCESS(status)) {
                            result = std::string(reinterpret_cast<char*>(plaintext.data()), ptLen);
                        } else {
                            // Fallback: treat as legacy XOR plaintext
                            result = std::string(xored.begin(), xored.end());
                        }
                    } else {
                        result = std::string(xored.begin(), xored.end());
                    }

                    BCryptDestroyKey(hKey);
                    BCryptCloseAlgorithmProvider(hAlg, 0);
                } else {
                    // Legacy: after XOR we have plaintext
                    result = std::string(xored.begin(), xored.end());
                }
            }

            WinHttpCloseHandle(hRequest);
            WinHttpCloseHandle(hConnect);
            WinHttpCloseHandle(hSession);
            return result;
        }

    public:
        AnxietyClient(const std::string& url, bool enhanced = true)
            : base_url(url), useEnhanced(enhanced) {
            if (!base_url.empty() && base_url.back() == '/') base_url.pop_back();
        }

        ~AnxietyClient() = default;

        std::string GetHWID() {
            if (hwid_cache.empty()) {
                hwid_cache = GenerateUUID();
            }
            return hwid_cache;
        }

        // --- Authorize: login + create session ---
        AuthResponse Authorize(const std::string& username, const std::string& password) {
            AuthResponse response;

            json body;
            body["username"] = username;
            body["password"] = password;
            body["hwid"] = GetHWID();

            std::string rawResponse = HTTPRequest("/api/main/auth", body);

            if (rawResponse.empty()) {
                response.error = "Empty response from server";
                return response;
            }
            if (rawResponse == "User not found") {
                response.error = "User not found. Register at aesthesia.xyz.";
                return response;
            }
            if (rawResponse == "Password mismatch") {
                response.error = "Incorrect password.";
                return response;
            }
            if (rawResponse == "HWID mismatch") {
                response.error = "HWID mismatch. Access denied.";
                return response;
            }
            if (rawResponse == "Account blocked") {
                response.error = "Account is blocked.";
                return response;
            }

            try {
                json j = json::parse(rawResponse);
                if (j.value("status", "") != "Success") {
                    response.error = "Server error: " + j.value("status", "unknown");
                    return response;
                }

                response.success = true;
                response.sessionId = j.value("session_id", "");

                if (j.contains("user")) {
                    auto& u = j["user"];
                    response.userId = u.value("id", "");
                    response.username = u.value("name", "Anon");
                    response.subscription.type = u.value("subscription_type", "None");
                    response.subscription.status = u.value("subscription_status", "Inactive");
                    response.subscription.expiryDate = u.value("expiry_date", "N/A");
                    response.subscription.currentDate = u.value("current_date", "");
                }
                session_id = response.sessionId;
            } catch (...) {}

            return response;
        }

        // --- Get Build Info ---
        BuildInfo GetBuildInfo(int productId = 0) {
            BuildInfo info;

            json body;
            if (productId > 0) body["product_id"] = productId;

            std::string rawResponse = HTTPRequest("/api/main/build", body, true);

            if (rawResponse.empty() || rawResponse == "Session expired" ||
                rawResponse == "Auth required" || rawResponse == "No active build found") {
                info.error = rawResponse.empty() ? "Empty response" : rawResponse;
                return info;
            }

            try {
                json j = json::parse(rawResponse);
                if (j.value("status", "") == "Success") {
                    info.success = true;
                    info.buildId = j.value("build_id", "");
                    info.buildHash = j.value("build_hash", "");
                }
            } catch (...) {}

            return info;
        }

        // --- Validate Build ---
        bool ValidateBuild(int productId = 0) {
            BuildInfo buildInfo = GetBuildInfo(productId);
            if (!buildInfo.success) return false;
            return buildInfo.buildId == CLIENT_VERSION;
        }

        // --- GetHWID via hwid.h ---
        std::string GenerateUUID(); // Defined in hwid.cpp
    };
}
