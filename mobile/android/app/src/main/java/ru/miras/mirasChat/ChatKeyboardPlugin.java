package ru.miras.mirasChat;

import android.view.WindowManager;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Переключает только открытый чат в режим, где Android IME накрывает WebView.
 * Штатный Keyboard.setResizeMode на Android не реализован, а глобальный
 * windowSoftInputMode="adjustNothing" сломал бы поля на логине и в диалогах.
 */
@CapacitorPlugin(name = "ChatKeyboard")
public class ChatKeyboardPlugin extends Plugin {
    private volatile boolean overlayActive = false;

    private void applyWindowMode(boolean active) {
        int mode = active
            ? WindowManager.LayoutParams.SOFT_INPUT_ADJUST_NOTHING
            : WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        getActivity().getWindow().setSoftInputMode(mode);
        getActivity().getWindow().getDecorView().requestApplyInsets();
        getActivity().getWindow().getDecorView().requestLayout();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (!overlayActive) return;
        getActivity().runOnUiThread(() -> {
            applyWindowMode(true);
            // На части прошивок IME восстанавливается уже после Activity.onResume и повторно
            // применяет resize. Возвращаем инвариант после завершения этого системного шага.
            getActivity().getWindow().getDecorView().postDelayed(() -> {
                if (overlayActive) applyWindowMode(true);
            }, 250);
        });
    }

    @PluginMethod
    public void setOverlay(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        overlayActive = active;

        getActivity().runOnUiThread(() -> {
            applyWindowMode(active);

            JSObject result = new JSObject();
            result.put("active", active);
            WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(getActivity().getWindow().getDecorView());
            int navigationBarPx = insets == null
                ? 0
                : insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom;
            float density = getActivity().getResources().getDisplayMetrics().density;
            result.put("navigationBarHeight", Math.round(navigationBarPx / density));
            call.resolve(result);
        });
    }
}
