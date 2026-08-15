package ru.miras.mirasChat;

import android.Manifest;
import android.app.DownloadManager;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Скачивание файла из переписки штатным загрузчиком Android.
 *
 * Почему не @capacitor/filesystem, с которого начинали: он пишет файл обычным
 * java.io.File в Environment.getExternalStoragePublicDirectory(DOCUMENTS), а с
 * Android 11 (scoped storage) запись в общие каталоги таким способом запрещена
 * — вызов молча падал, и нажатие на файл не делало ничего. Никакого разрешения
 * при этом не спрашивалось: плагин считает, что на API 30+ оно не нужно.
 *
 * DownloadManager — то, чем система скачивает файлы сама: кладёт их в «Загрузки»
 * (единственное место, куда приложению можно писать без разрешений), показывает
 * ход загрузки в шторке и уведомление по готовности, а сам файл потом виден в
 * «Загрузках» и в любом файловом менеджере. Ровно то, чего человек ждёт от
 * кнопки «скачать», и без ухода в браузер.
 *
 * Разрешение WRITE_EXTERNAL_STORAGE нужно только на Android 9 и старше (до
 * scoped storage); на 10+ оно не запрашивается вовсе — см. манифест, где у него
 * стоит maxSdkVersion.
 */
@CapacitorPlugin(
    name = "FileDownload",
    permissions = {
        @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class FileDownloadPlugin extends Plugin {

    /** Имя файла на диске: без разделителей пути и не пустое. */
    private String safeName(String raw) {
        String value = raw == null ? "" : raw.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return value.isEmpty() ? "file" : value;
    }

    private boolean needsLegacyPermission() {
        return Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
            && getPermissionState("storage") != PermissionState.GRANTED;
    }

    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            call.reject("Некорректный адрес файла");
            return;
        }

        if (needsLegacyPermission()) {
            requestPermissionForAlias("storage", call, "storagePermissionCallback");
            return;
        }

        enqueue(call);
    }

    @PermissionCallback
    private void storagePermissionCallback(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("Нет доступа к хранилищу — файл сохранить некуда");
            return;
        }
        enqueue(call);
    }

    private void enqueue(PluginCall call) {
        String url = call.getString("url");
        String filename = safeName(call.getString("filename"));

        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle(filename);
            request.setDescription("MirasChat");
            // Уведомление обязательно: без него загрузка идёт незаметно, и
            // человек снова не понимает, произошло ли хоть что-нибудь.
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            // Совпадение имён DownloadManager разруливает сам, дописывая «-1».
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);

            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                call.reject("Системный загрузчик недоступен");
                return;
            }
            long id = manager.enqueue(request);

            JSObject result = new JSObject();
            result.put("id", id);
            result.put("location", "Загрузки");
            call.resolve(result);
        } catch (Exception e) {
            // Чаще всего это отключённый пользователем «Загрузчик» системы —
            // сообщаем причину, а не молчим.
            String message = e.getMessage();
            call.reject(message == null || message.isEmpty() ? "Не удалось начать загрузку" : message);
        }
    }
}
