#pragma once
// ============================================================
//  loader.h — Updated loader header for Anxiety (aesthesia.xyz).
//  Использует AnxietyAPI::AnxietyClient вместо MorpheusAPI::MorpheusClient.
// ============================================================

#include <windows.h>
#include <d3d11.h>
#include <string>

// ImGui
#include "../dependencies/imgui.h"
#include "../dependencies/imgui_impl_dx11.h"
#include "../dependencies/imgui_impl_win32.h"

// Font
#include "../RidtypeProDemo.h"

// API Client (enhanced)
#include "MPHClient.h"
#include "hwid.h"

// API URL — HTTPS, VPS aesthesia.xyz
#define API_URL "https://aesthesia.xyz"

enum class AppLanguage { English, Russian };
enum class AppState { Initializing, Login, Product, Error };

namespace Loader {
    inline AppLanguage currentLanguage = AppLanguage::English;
    inline AppState currentState = AppState::Initializing;
    inline std::string statusMessage;
    inline bool isRunning = true;
    inline bool isMinimized = false;

    // Auth
    inline std::string username, password, hwid;
    inline std::string subscriptionType, subscriptionStatus, expiryDate;
    inline std::string sessionId;

    // Input buffers
    inline char usernameBuf[64] = "";
    inline char passwordBuf[64] = "";

    // API Client
    inline AnxietyAPI::AnxietyClient* apiClient = nullptr;

    // Fonts
    inline ImFont* mainFont = nullptr;
    inline ImFont* titleFont = nullptr;
    inline ImFont* subtitleFont = nullptr;

    // D3D11
    inline ID3D11Device* pDevice = nullptr;
    inline ID3D11DeviceContext* pContext = nullptr;
    inline IDXGISwapChain* pSwapChain = nullptr;
    inline ID3D11RenderTargetView* pRenderTargetView = nullptr;

    // Window
    inline HWND hWnd = nullptr;
    inline WNDCLASSEX wc = {};
    inline MSG msg = {};
    inline HMODULE hModule = nullptr;

    constexpr int WINDOW_W = 420;
    constexpr int WINDOW_H = 280;
    constexpr int TITLEBAR_H = 30;
}

// --- Init / Cleanup ---
bool InitWindow();
bool InitD3D();
void CleanupD3D();
void RenderFrame();
void RenderTitleBar();
void RenderLogin();
void RenderProduct();
void DoLogin();
void Cleanup();
void UnloadSelf();
