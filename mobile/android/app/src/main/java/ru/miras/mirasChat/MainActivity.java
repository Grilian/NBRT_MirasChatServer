package ru.miras.mirasChat;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ChatKeyboardPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
